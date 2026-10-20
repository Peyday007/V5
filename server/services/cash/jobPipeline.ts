/**
 * From a qualified opportunity to an execution job, and what that job is doing.
 *
 * ---------------------------------------------------------------------------
 * The link that was missing
 * ---------------------------------------------------------------------------
 *
 * `cash_jobs` was created by migration 061 with a partial unique index on live
 * jobs, a compare-and-swap assignment and a redaction rule — and nothing in the
 * server ever wrote one. Qualification derived a tier, `execution.ts` derived a
 * plan, `advanceWithinAuthority` readied and contacted, and no row anywhere
 * said *this opportunity is now a job, owned by this person, at this stage*.
 * So a person reading Cash saw research and evidence and never a job, however
 * far an opening had got. A mechanism nothing calls is not a mechanism.
 *
 * `reconcileCashJobs` is the caller, on the durable tick. It is a derivation
 * rather than a hook on the moment a tier changes, for the reason this
 * repository keeps recording: a tier is derived and never written down when it
 * changes, so there is no moment to hook — and a derivation reaches the
 * openings that qualified before this existed.
 *
 * ---------------------------------------------------------------------------
 * What is stored, and what is derived
 * ---------------------------------------------------------------------------
 *
 * The job row holds what no derivation could recover: that this opening became
 * somebody's work, who owns it, and when. Its `state` follows the opportunity's
 * own state machine and is moved only by guarded compare-and-swaps.
 *
 * The **tasks** are derived on every read from rows that already exist — the
 * card, the open needs, the live grant, the capability readings, the recorded
 * actions, the agreements and the ledger — because each task's status is a
 * fact those rows already state. A stored task status would be a second master
 * for the same fact, and the one nobody reads is the one that drifts.
 *
 * ---------------------------------------------------------------------------
 * What it refuses
 * ---------------------------------------------------------------------------
 *
 * It contacts nobody, spends nothing, records no action and moves no
 * opportunity. The work it reports as running is run by passes that already
 * exist (`advanceWithinAuthority`, the need research, the invoicing pass, the
 * journey), each through its own authority check. A job whose expected
 * contribution is known to be negative is **not** created: preparing work that
 * the published figures already say loses money would be the fabricated ready
 * job this module must not produce, and the reason is reported instead.
 */
import { getDb } from '../../db/database.ts';
import { getCashMode, recordCashEvent } from '../../repos/cashMode.ts';
import { listOpportunities, listNeeds } from '../../repos/cashPortfolio.ts';
import { cardFactsForProject } from '../../repos/cashCardFacts.ts';
import { createJob, listJobs, liveJobFor, releaseJob, setJobState } from '../../repos/cashJobs.ts';
import { actionsFor } from '../../repos/cashActions.ts';
import { agreementsFor } from '../../repos/cashJourney.ts';
import { cashEngineCard } from './engineCard.ts';
import { evidenceCard } from './card.ts';
import { cashTier, type TierReading } from './tier.ts';
import { checkCommercialAuthority } from './authority.ts';
import { readAllCapabilities, type CapabilityReading } from './capabilities.ts';
import { totalsByKind } from '../../repos/cashLedger.ts';
import { dealPosition } from './journey/position.ts';
import type {
  CashCardFact,
  CashJob,
  CashJobState,
  CashNeed,
  CashOpportunity,
  CashOpportunityState,
} from '../../domain/types.ts';

/* --------------------------------------------------------------------------
 * The vocabulary
 * ------------------------------------------------------------------------ */

/**
 * Where an opportunity stands on the road from discovery to usable cash.
 *
 * Ten stages, in order, and each one is a different fact. Preparation is never
 * a commitment, a commitment is never a delivery, and a payment is never usable
 * cash until it has settled — collapsing any two of these is how a screen
 * comes to report prepared offers as accepted orders.
 */
export const PIPELINE_STAGES = [
  'DISCOVERED',
  'UNDER_QUALIFICATION',
  'QUALIFIED',
  'JOB_PREPARED',
  'READY_BLOCKED',
  'EXECUTING',
  'AGREED',
  'DELIVERED',
  'PAID',
  'SETTLED',
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const PIPELINE_STAGE_LABELS: Readonly<Record<PipelineStage, string>> = Object.freeze({
  DISCOVERED: 'Discovered — evidence, not yet work',
  UNDER_QUALIFICATION: 'Under qualification',
  QUALIFIED: 'Qualified, no job',
  JOB_PREPARED: 'Execution job prepared',
  READY_BLOCKED: 'Ready to execute, blocked',
  EXECUTING: 'Executing',
  AGREED: 'Buyer agreement obtained',
  DELIVERED: 'Delivered',
  PAID: 'Payment received (not yet usable)',
  SETTLED: 'Funds settled and usable',
});

/** Who or what carries out one task. Closed; there is no "somebody". */
export const TASK_EXECUTORS = [
  /** Composed by Brain from rows it already holds; no worker, no fire. */
  'BRAIN_DETERMINISTIC',
  /** Answered by the research fleet through a need or a deep dive. */
  'BRAIN_RESEARCH',
  /** Performed by a registered effect adapter, under the standing grant. */
  'PROVIDER',
  /** A supplier, contractor or tool the job engages. */
  'VENDOR',
  /** The buyer's own act: replying, agreeing, paying. */
  'BUYER',
  /** A decision or a signature only a person holds. */
  'PERSON',
] as const;
export type TaskExecutor = (typeof TASK_EXECUTORS)[number];

export const TASK_STATUSES = [
  'DONE',
  /** Running now, or will run on the next tick with nothing in its way. */
  'IN_PROGRESS',
  /** Waiting on research Brain is doing or will start itself. */
  'WAITING_RESEARCH',
  /** Waiting on a step before it in this job. */
  'BLOCKED_DEPENDENCY',
  /** The standing commercial grant does not cover it. */
  'BLOCKED_AUTHORITY',
  /** A provider integration it needs is not configured. */
  'BLOCKED_PROVIDER',
  /** Waiting on the buyer. */
  'WAITING_BUYER',
  /** Waiting on a person's own act, with the way to record it. */
  'WAITING_PERSON',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface JobTask {
  key: string;
  action: string;
  executor: TaskExecutor;
  status: TaskStatus;
  /** One sentence: why it is in this status, and what moves it. */
  because: string;
  /** The commercial action it needs, when it is an effect on the world. */
  requiresAuthority: string | null;
  /** The capability it needs, when one is load-bearing. */
  requiresCapability: string | null;
  dependsOn: string[];
  /** What proves it happened. */
  artifact: string;
}

/* --------------------------------------------------------------------------
 * Which openings become jobs
 * ------------------------------------------------------------------------ */

const LIVE_STATES: ReadonlySet<CashOpportunityState> = new Set([
  'DISCOVERED',
  'EVIDENCE_CARD',
  'READY',
  'EXECUTING',
  'DELIVERING',
  'COLLECTED',
]);

/** States a person or Brain already took the opportunity into as work. */
const TAKEN_STATES: ReadonlySet<CashOpportunityState> = new Set([
  'READY',
  'EXECUTING',
  'DELIVERING',
  'COLLECTED',
]);

export type JobEligibility =
  | { eligible: true; because: string }
  | { eligible: false; because: string };

/**
 * May this opening be an execution job, from its own rows. Pure.
 *
 * Eligible when the qualification is complete (`QUALIFIED` or `READY_TO_TEST`)
 * or when somebody already took it into the state machine as work. Refused,
 * with the reason, when it is a duplicate, was closed by a published deadline,
 * or its published figures already say it loses money.
 */
export function jobEligibility(opportunity: CashOpportunity, tier: TierReading, closed: boolean): JobEligibility {
  if (!LIVE_STATES.has(opportunity.state)) {
    return { eligible: false, because: `it is ${opportunity.state.toLowerCase()}` };
  }
  if (opportunity.duplicateOfId) {
    return { eligible: false, because: `it is a second record of ${opportunity.duplicateOfId}` };
  }
  const taken = TAKEN_STATES.has(opportunity.state);
  if (!taken && closed) {
    return { eligible: false, because: 'its published deadline has passed' };
  }
  if (!taken && tier.tier !== 'QUALIFIED' && tier.tier !== 'READY_TO_TEST') {
    return { eligible: false, because: `it is ${tier.tier.toLowerCase().replace(/_/g, ' ')}, not qualified` };
  }
  if (
    !taken &&
    opportunity.priceCents !== null &&
    opportunity.peakFundingCents !== null &&
    opportunity.priceCents < opportunity.peakFundingCents
  ) {
    return {
      eligible: false,
      because:
        `its published price (${money(opportunity.priceCents, opportunity.currency)}) does not ` +
        `cover its published capital exposure (${money(opportunity.peakFundingCents, opportunity.currency)}), ` +
        'so the figures say one sale loses money',
    };
  }
  return {
    eligible: true,
    because: taken
      ? `it is already ${opportunity.state.toLowerCase()}`
      : `it is ${tier.tier === 'READY_TO_TEST' ? 'ready to test' : 'qualified'}`,
  };
}

/** The job state an opportunity's own state implies. */
function jobStateFor(state: CashOpportunityState): CashJobState | 'RELEASE' {
  switch (state) {
    case 'EXECUTING':
      return 'EXECUTING';
    case 'DELIVERING':
      return 'DELIVERING';
    case 'COLLECTED':
      return 'COLLECTED';
    case 'DECLINED':
    case 'ARCHIVED':
      return 'RELEASE';
    default:
      return 'ASSIGNED';
  }
}

/* --------------------------------------------------------------------------
 * The pass
 * ------------------------------------------------------------------------ */

export interface JobReconciliation {
  created: { jobId: string; opportunityId: string; because: string }[];
  advanced: { jobId: string; from: CashJobState; to: CashJobState }[];
  released: { jobId: string; because: string }[];
  /** Qualified openings that were not made jobs, each with its reason. */
  declined: { opportunityId: string; because: string }[];
}

interface TierContext {
  opportunity: CashOpportunity;
  tier: TierReading;
  closed: boolean;
}

/** Card facts once per project, the tier per piece — the composition `cashView` performs. */
async function tiersFor(projectId: string): Promise<TierContext[]> {
  const opportunities = await listOpportunities({ projectId });
  const facts = new Map<string, CashCardFact[]>();
  for (const fact of await cardFactsForProject(projectId)) {
    facts.set(fact.opportunityId, [...(facts.get(fact.opportunityId) ?? []), fact]);
  }
  return opportunities.map((opportunity) => {
    const card = cashEngineCard({ opportunity, facts: facts.get(opportunity.id) ?? [] });
    return {
      opportunity,
      tier: cashTier({ opportunity, card, readiness: evidenceCard(opportunity).readiness }),
      closed: Boolean(card.disqualifiedBy?.closed),
    };
  });
}

export const JOB_PREPARED_EVENT = 'CASH_JOB_PREPARED';
export const JOB_STATE_EVENT = 'CASH_JOB_STATE';
export const JOB_RELEASED_EVENT = 'CASH_JOB_RELEASED';

/**
 * Create or reuse the canonical job for every actionable opening, and keep each
 * live job's state in step with its opportunity. Idempotent: the unique index
 * on live jobs makes a repeated tick, a restart and two instances one job.
 */
export async function reconcileCashJobs(projectId: string): Promise<JobReconciliation> {
  const out: JobReconciliation = { created: [], advanced: [], released: [], declined: [] };
  const mode = await getCashMode(projectId);
  if (!mode) return out;

  const contexts = await tiersFor(projectId);
  const jobsByOpportunity = new Map<string, CashJob>();
  /*
   * A COLLECTED job is the canonical job of a finished deal even though the
   * partial unique index no longer covers it. Leaving it out of this map made
   * the next pass see a COLLECTED opportunity with "no job" and prepare a
   * second one — found by the discovery-to-settlement walk. Only a RELEASED
   * job gives way to a new one, and only while the opening is still eligible.
   */
  for (const job of await listJobs(projectId)) {
    if (job.state === 'RELEASED') continue;
    if (!jobsByOpportunity.has(job.opportunityId)) jobsByOpportunity.set(job.opportunityId, job);
  }

  for (const { opportunity, tier, closed } of contexts) {
    let job = jobsByOpportunity.get(opportunity.id) ?? null;

    if (!job) {
      const eligibility = jobEligibility(opportunity, tier, closed);
      if (!eligibility.eligible) {
        if (tier.tier === 'QUALIFIED' || tier.tier === 'READY_TO_TEST') {
          out.declined.push({ opportunityId: opportunity.id, because: eligibility.because });
        }
        continue;
      }
      /*
       * Opening a job is not a winding-down sprint's business. A wound-down
       * sprint keeps every obligation it holds, so a piece already taken into
       * execution still gets its job; one that merely qualified does not start
       * new work after somebody said stop.
       */
      if (mode.state !== 'ACTIVE' && !TAKEN_STATES.has(opportunity.state)) continue;
      const created = await createJob({
        opportunityId: opportunity.id,
        projectId,
        currency: opportunity.currency,
        ownerUserId: opportunity.ownerUserId,
        createdBy: 'BRAIN',
        note: `Prepared because ${eligibility.because}.`,
      });
      if (!created) {
        // Another tick or instance won the insert; read what it wrote.
        job = await liveJobFor(opportunity.id);
        if (!job) continue;
      } else {
        job = created;
        out.created.push({ jobId: job.id, opportunityId: opportunity.id, because: eligibility.because });
        await recordCashEvent({
          projectId,
          opportunityId: opportunity.id,
          kind: JOB_PREPARED_EVENT,
          actorRef: 'BRAIN',
          summary: `Execution job prepared for "${opportunity.title}" because ${eligibility.because}.`,
          detail: { jobId: job.id, tier: tier.tier, opportunityState: opportunity.state },
        });
      }
    }

    const target = jobStateFor(opportunity.state);
    if (target === 'RELEASE' || opportunity.duplicateOfId) {
      const because = opportunity.duplicateOfId
        ? `it was found to be a second record of ${opportunity.duplicateOfId}`
        : `the opportunity was ${opportunity.state.toLowerCase()}`;
      if (await releaseJob({ jobId: job.id, reason: because })) {
        out.released.push({ jobId: job.id, because });
        await recordCashEvent({
          projectId,
          opportunityId: opportunity.id,
          kind: JOB_RELEASED_EVENT,
          actorRef: 'BRAIN',
          summary: `Execution job released: ${because}.`,
          detail: { jobId: job.id },
        });
      }
      continue;
    }
    if (job.state === 'COLLECTED') continue;
    if (target !== job.state && job.state !== 'UNASSIGNED') {
      if (await setJobState({ jobId: job.id, expectState: job.state, to: target })) {
        out.advanced.push({ jobId: job.id, from: job.state, to: target });
        await recordCashEvent({
          projectId,
          opportunityId: opportunity.id,
          kind: JOB_STATE_EVENT,
          actorRef: 'BRAIN',
          summary: `Execution job moved from ${job.state} to ${target}, following the opportunity.`,
          detail: { jobId: job.id, from: job.state, to: target },
        });
      }
    }
  }
  return out;
}

/* --------------------------------------------------------------------------
 * The tasks, derived
 * ------------------------------------------------------------------------ */

export interface TaskContext {
  opportunity: CashOpportunity;
  needs: readonly CashNeed[];
  capabilities: ReadonlyMap<string, CapabilityReading>;
  /** Per commercial action: whether the live grant covers it, and why not. */
  authority: ReadonlyMap<string, { ok: boolean; reason: string }>;
  contacted: boolean;
  agreed: boolean;
  delivered: boolean;
  paid: boolean;
  settled: boolean;
  sprintActive: boolean;
}

function capabilityOk(ctx: TaskContext, id: string): { ok: boolean; because: string } {
  const reading = ctx.capabilities.get(id);
  if (!reading) return { ok: false, because: `${id} has never been read` };
  if (reading.state === 'PRESENT') return { ok: true, because: `${id} is connected` };
  return {
    ok: false,
    because: `${id} reads ${reading.state} — it needs ${reading.definition?.requires ?? 'an integration Brain has no word for'}`,
  };
}

function openNeedFor(ctx: TaskContext, field: string): CashNeed | null {
  return (
    ctx.needs.find(
      (need) => need.opportunityId === ctx.opportunity.id && need.state === 'OPEN' && (need.blockerKey ?? '') === `FIELD:${field}`,
    ) ?? null
  );
}

function researchBecause(ctx: TaskContext, field: string, label: string): string {
  const need = openNeedFor(ctx, field);
  return need
    ? `${label} is not established yet; Brain is researching it (need ${need.id}).`
    : `${label} is not established yet; Brain raises research for it on the next pass.`;
}

/**
 * The job's tasks, built backwards from usable cash the way `execution.ts`
 * builds its plan, each with an executor and a status read from rows. Pure.
 */
export function jobTasks(ctx: TaskContext): JobTask[] {
  const o = ctx.opportunity;
  const tasks: JobTask[] = [];
  const done = (key: string): boolean => tasks.find((t) => t.key === key)?.status === 'DONE';

  // 1. The offer: composed by Brain from the card.
  const hasOffer = Boolean(o.offerScope && o.offerScope.trim()) && o.priceCents !== null && o.priceCents > 0;
  tasks.push({
    key: 'offer',
    action: 'Prepare the offer: scope, exclusions, price and acceptance condition',
    executor: 'BRAIN_DETERMINISTIC',
    status: hasOffer ? 'DONE' : 'WAITING_RESEARCH',
    because: hasOffer
      ? 'The offer is composed from the card: its scope and its price are both recorded.'
      : researchBecause(ctx, o.offerScope ? 'price' : 'offer', o.offerScope ? 'The price' : 'The offer scope'),
    requiresAuthority: null,
    requiresCapability: null,
    dependsOn: [],
    artifact: 'the offer, composed from the card',
  });

  // 2. The buyer and how to reach them: research.
  const hasTarget = Boolean(o.payer) && Boolean(o.reachableChannel);
  tasks.push({
    key: 'buyer',
    action: o.payer ? `Confirm how to reach the buyer: ${o.payer}` : 'Establish who pays and how to reach them',
    executor: 'BRAIN_RESEARCH',
    status: hasTarget ? 'DONE' : 'WAITING_RESEARCH',
    because: hasTarget
      ? 'The payer and a published channel to them are both recorded.'
      : researchBecause(ctx, o.payer ? 'access' : 'payer', o.payer ? 'A published channel to the buyer' : 'The payer'),
    requiresAuthority: null,
    requiresCapability: null,
    dependsOn: [],
    artifact: 'the payer and the channel they published, each with its source',
  });

  // 3. Evidence of current demand.
  const hasEvidence = Boolean(o.buyingSignal) && Boolean(o.signalObservedAt);
  tasks.push({
    key: 'evidence',
    action: 'Hold dated evidence of current demand',
    executor: 'BRAIN_RESEARCH',
    status: hasEvidence ? 'DONE' : 'WAITING_RESEARCH',
    because: hasEvidence
      ? `The buying signal is recorded, observed ${o.signalObservedAt}.`
      : researchBecause(ctx, 'buyingEvidence', 'A dated buying signal'),
    requiresAuthority: null,
    requiresCapability: null,
    dependsOn: [],
    artifact: 'the buying signal, its source and its date',
  });

  // 4. Supplier / fulfilment inputs, only when the card names any.
  if (o.requiredInputs && o.requiredInputs.trim()) {
    const engage = ctx.authority.get('ENGAGE_CONTRACTOR');
    tasks.push({
      key: 'fulfilment',
      action: `Line up what delivery requires: ${o.requiredInputs.trim()}`,
      executor: 'VENDOR',
      status: ctx.agreed ? 'DONE' : engage?.ok ? 'IN_PROGRESS' : 'BLOCKED_AUTHORITY',
      because: ctx.agreed
        ? 'Delivery inputs are committed against the agreement.'
        : engage?.ok
          ? 'Engaging a supplier is covered by the standing grant; it is committed once a buyer agrees.'
          : `Engaging a supplier needs ENGAGE_CONTRACTOR: ${engage?.reason ?? 'no standing commercial authority'}. Preparation continues without it.`,
      requiresAuthority: 'ENGAGE_CONTRACTOR',
      requiresCapability: null,
      dependsOn: ['offer'],
      artifact: 'each input committed, named individually',
    });
  }

  // 5. Contacting the buyer: the first effect on the world.
  const contactAuth = ctx.authority.get('CONTACT_BUYER');
  const send = capabilityOk(ctx, 'SEND_A_MESSAGE');
  const prepDone = done('offer') && done('buyer') && done('evidence');
  let contactStatus: TaskStatus;
  let contactBecause: string;
  if (ctx.contacted) {
    contactStatus = 'DONE';
    contactBecause = 'A contact with the buyer is recorded as a confirmed action.';
  } else if (!prepDone) {
    contactStatus = 'BLOCKED_DEPENDENCY';
    contactBecause = 'Waits for the offer, the buyer and the evidence to be established first.';
  } else if (!contactAuth?.ok) {
    contactStatus = 'BLOCKED_AUTHORITY';
    contactBecause =
      `Reaching the buyer needs CONTACT_BUYER under a standing commercial grant: ` +
      `${contactAuth?.reason ?? 'no standing commercial authority exists for this project'}. ` +
      'Grant it on Cash → What Brain is allowed to do.';
  } else if (!send.ok) {
    contactStatus = 'BLOCKED_PROVIDER';
    contactBecause =
      `Authorized, and ${send.because}. Alternatively a person sends the message and records it ` +
      'as a confirmed CONTACT_BUYER action on the opportunity.';
  } else if (!ctx.sprintActive) {
    contactStatus = 'WAITING_PERSON';
    contactBecause = 'The sprint is winding down, so Brain starts no new contact.';
  } else if (o.state !== 'READY') {
    contactStatus = 'IN_PROGRESS';
    contactBecause = 'Authorized and connected; Brain marks the card ready and writes to the buyer on the next pass.';
  } else {
    contactStatus = 'IN_PROGRESS';
    contactBecause = 'Authorized and connected; Brain writes to the buyer on the next pass.';
  }
  tasks.push({
    key: 'contact',
    action: o.reachableChannel ? `Send the offer through: ${o.reachableChannel}` : 'Send the offer to the buyer',
    executor: 'PROVIDER',
    status: contactStatus,
    because: contactBecause,
    requiresAuthority: 'CONTACT_BUYER',
    requiresCapability: 'SEND_A_MESSAGE',
    dependsOn: ['offer', 'buyer', 'evidence'],
    artifact: 'the sent message, its recipient, timestamp and provider receipt',
  });

  // 6. Agreement: the buyer's act.
  tasks.push({
    key: 'agree',
    action: o.acceptanceCondition ? `Agree scope and price: ${o.acceptanceCondition}` : 'Get written agreement on scope and price',
    executor: 'BUYER',
    status: ctx.agreed ? 'DONE' : ctx.contacted ? 'WAITING_BUYER' : 'BLOCKED_DEPENDENCY',
    because: ctx.agreed
      ? 'An agreement is recorded with its evidence.'
      : ctx.contacted
        ? "Waiting for the buyer's reply; an agreement is recorded only with evidence of it."
        : 'Waits for the buyer to be contacted.',
    requiresAuthority: null,
    requiresCapability: null,
    dependsOn: ['contact'],
    artifact: "the buyer's written acceptance, naming scope and price",
  });

  // 7. Delivery.
  const deliveredBy = o.fulfillmentOwner?.toLowerCase().includes('brain') ? 'BRAIN_RESEARCH' : 'VENDOR';
  tasks.push({
    key: 'deliver',
    action: o.deliveryMethod ? `Deliver by: ${o.deliveryMethod}` : 'Deliver the agreed work',
    executor: deliveredBy,
    status: ctx.delivered ? 'DONE' : ctx.agreed ? 'IN_PROGRESS' : 'BLOCKED_DEPENDENCY',
    because: ctx.delivered
      ? 'Delivery and the buyer\'s acceptance are recorded on the obligation.'
      : ctx.agreed
        ? 'The obligation is open; delivery is tracked on it.'
        : 'Waits for an agreement.',
    requiresAuthority: null,
    requiresCapability: null,
    dependsOn: ['agree'],
    artifact: 'the delivered work and the buyer acknowledging receipt',
  });

  // 8. Invoice and collect.
  const invoiceAuth = ctx.authority.get('QUOTE_AND_INVOICE');
  const invoicing = capabilityOk(ctx, 'ISSUE_AN_INVOICE');
  let collectStatus: TaskStatus;
  let collectBecause: string;
  if (ctx.settled) {
    collectStatus = 'DONE';
    collectBecause = 'The payment has settled and is usable cash.';
  } else if (ctx.paid) {
    collectStatus = 'IN_PROGRESS';
    collectBecause = 'Paid; waiting for the provider to settle it. Paid is not yet usable cash.';
  } else if (!ctx.agreed) {
    collectStatus = 'BLOCKED_DEPENDENCY';
    collectBecause = 'Nothing is invoiced before an agreement.';
  } else if (!invoiceAuth?.ok) {
    collectStatus = 'BLOCKED_AUTHORITY';
    collectBecause = `Invoicing needs QUOTE_AND_INVOICE: ${invoiceAuth?.reason ?? 'no standing commercial authority'}.`;
  } else if (!invoicing.ok) {
    collectStatus = 'WAITING_PERSON';
    collectBecause =
      `${invoicing.because} The invoice can be issued outside Brain and the payment recorded with its reference.`;
  } else {
    collectStatus = 'IN_PROGRESS';
    collectBecause = 'Authorized and connected; the invoicing pass bills what is agreed.';
  }
  tasks.push({
    key: 'collect',
    action: 'Invoice, collect and settle',
    executor: invoicing.ok ? 'PROVIDER' : 'PERSON',
    status: collectStatus,
    because: collectBecause,
    requiresAuthority: 'QUOTE_AND_INVOICE',
    requiresCapability: 'ISSUE_AN_INVOICE',
    dependsOn: ['agree'],
    artifact: 'an invoice, a payment and a settlement, each with its provider reference',
  });

  return tasks;
}

/** The stage a job's tasks and ledger put it in. Pure. */
export function jobStage(tasks: readonly JobTask[], ctx: Pick<TaskContext, 'opportunity' | 'agreed' | 'delivered' | 'paid' | 'settled' | 'contacted'>): PipelineStage {
  if (ctx.settled || ctx.opportunity.state === 'COLLECTED') return 'SETTLED';
  if (ctx.paid) return 'PAID';
  if (ctx.delivered || ctx.opportunity.state === 'DELIVERING') return 'DELIVERED';
  if (ctx.agreed) return 'AGREED';
  if (ctx.contacted || ctx.opportunity.state === 'EXECUTING') return 'EXECUTING';
  const contact = tasks.find((t) => t.key === 'contact');
  if (contact && contact.status === 'IN_PROGRESS') return 'EXECUTING';
  if (contact && (contact.status === 'BLOCKED_AUTHORITY' || contact.status === 'BLOCKED_PROVIDER' || contact.status === 'WAITING_PERSON')) {
    return 'READY_BLOCKED';
  }
  return 'JOB_PREPARED';
}

/** The single next action, and who takes it. */
export function nextAction(tasks: readonly JobTask[]): { task: string; executor: TaskExecutor; because: string } | null {
  const order: TaskStatus[] = [
    'BLOCKED_AUTHORITY',
    'BLOCKED_PROVIDER',
    'WAITING_PERSON',
    'IN_PROGRESS',
    'WAITING_RESEARCH',
    'WAITING_BUYER',
  ];
  for (const status of order) {
    const task = tasks.find((t) => t.status === status);
    if (task) return { task: task.action, executor: task.executor, because: task.because };
  }
  return null;
}

/* --------------------------------------------------------------------------
 * The reading Cash renders
 * ------------------------------------------------------------------------ */

export interface JobView {
  jobId: string;
  opportunityId: string;
  title: string;
  jobState: CashJobState;
  stage: PipelineStage;
  stageLabel: string;
  ownerUserId: string | null;
  createdAt: string;
  /** Per-sale price and the published exposure, never a forecast. */
  priceCents: number | null;
  exposureCents: number | null;
  contributionPerSaleCents: number | null;
  currency: string;
  tasks: JobTask[];
  blockers: string[];
  next: { task: string; executor: TaskExecutor; because: string } | null;
}

export interface PipelineReading {
  counts: Record<PipelineStage, number>;
  labels: Readonly<Record<PipelineStage, string>>;
  jobs: JobView[];
  /** Qualified openings that were not made jobs, with the reason each. */
  qualifiedWithoutJob: { opportunityId: string; title: string; because: string }[];
  /** Settled usable cash, from the ledger. Never a forecast. */
  settledCents: number;
  /** Customer payments not yet settled. */
  paidUnsettledCents: number;
  currency: string;
  /** Live research packets and deep dives: research, never jobs. */
  researchInFlight: number;
  authority: { live: boolean; allowedActions: string[] };
  providers: { id: string; state: string; nextStep: string | null }[];
}

const AUTHORITY_ACTIONS = ['CONTACT_BUYER', 'QUOTE_AND_INVOICE', 'ACCEPT_PAYMENT', 'ENGAGE_CONTRACTOR'];
const PROVIDER_CAPABILITIES = ['SEND_A_MESSAGE', 'ISSUE_AN_INVOICE', 'TAKE_A_PAYMENT'];

function money(cents: number, currency: string): string {
  return `${currency} ${(cents / 100).toFixed(2)}`;
}

function stageForUnjobbed(tier: TierReading): PipelineStage {
  if (tier.tier === 'SIGNAL') return 'DISCOVERED';
  if (tier.tier === 'CANDIDATE') return 'UNDER_QUALIFICATION';
  return 'QUALIFIED';
}

/**
 * The whole road for one project, read once. Writes nothing.
 *
 * `includeOwnerOnly` is false for a reader who may not see a job's private
 * half: the counts and stages are shared frontier facts, the tasks and money
 * of somebody else's job are not.
 */
export async function pipelineReading(
  projectId: string,
  viewer: { userId: string | null; owner: boolean },
): Promise<PipelineReading | null> {
  const mode = await getCashMode(projectId);
  if (!mode) return null;
  const contexts = await tiersFor(projectId);
  const jobs = new Map<string, CashJob>();
  for (const job of await listJobs(projectId)) {
    if (job.state === 'RELEASED') continue;
    if (!jobs.has(job.opportunityId)) jobs.set(job.opportunityId, job);
  }
  const needs = await listNeeds({ projectId, states: ['OPEN'] });
  const capabilities = await readAllCapabilities();
  const authority = new Map<string, { ok: boolean; reason: string }>();
  for (const action of AUTHORITY_ACTIONS) {
    const decision = await checkCommercialAuthority({ projectId, action });
    authority.set(action, { ok: decision.ok, reason: decision.reason });
  }

  const counts = Object.fromEntries(PIPELINE_STAGES.map((s) => [s, 0])) as Record<PipelineStage, number>;
  const views: JobView[] = [];
  const qualifiedWithoutJob: PipelineReading['qualifiedWithoutJob'] = [];

  for (const { opportunity, tier, closed } of contexts) {
    if (opportunity.duplicateOfId || !LIVE_STATES.has(opportunity.state)) continue;
    const job = jobs.get(opportunity.id);
    if (!job) {
      if (closed && !TAKEN_STATES.has(opportunity.state)) continue;
      const stage = stageForUnjobbed(tier);
      counts[stage] += 1;
      if (stage === 'QUALIFIED') {
        const eligibility = jobEligibility(opportunity, tier, closed);
        qualifiedWithoutJob.push({
          opportunityId: opportunity.id,
          title: opportunity.title,
          because: eligibility.eligible
            ? 'it is eligible; the next pass prepares its job'
            : `not made a job because ${eligibility.because}`,
        });
      }
      continue;
    }

    const [actions, agreements] = await Promise.all([actionsFor(opportunity.id), agreementsFor(opportunity.id)]);
    const agreed = agreements.some((a) => a.state === 'AGREED');
    let delivered = false;
    let paid = false;
    let settled = false;
    if (agreed || TAKEN_STATES.has(opportunity.state)) {
      const position = await dealPosition({ opportunity, currency: mode.currency });
      delivered = position.delivered;
      paid = position.pnl.paidNetCents > 0;
      settled = position.pnl.settledCashCents > 0 && position.pnl.unsettledCents === 0;
    }
    const ctx: TaskContext = {
      opportunity,
      needs,
      capabilities,
      authority,
      contacted: actions.some((a) => a.action === 'CONTACT_BUYER'),
      agreed,
      delivered,
      paid,
      settled,
      sprintActive: mode.state === 'ACTIVE',
    };
    const tasks = jobTasks(ctx);
    const stage = jobStage(tasks, ctx);
    counts[stage] += 1;
    const mine = viewer.owner || job.visibility === 'SHARED' || job.ownerUserId === viewer.userId;
    const blockers = tasks
      .filter((t) => t.status === 'BLOCKED_AUTHORITY' || t.status === 'BLOCKED_PROVIDER')
      .map((t) => t.because);
    views.push({
      jobId: job.id,
      opportunityId: opportunity.id,
      title: opportunity.title,
      jobState: job.state,
      stage,
      stageLabel: PIPELINE_STAGE_LABELS[stage],
      ownerUserId: mine ? job.ownerUserId : null,
      createdAt: job.createdAt,
      priceCents: mine ? opportunity.priceCents : null,
      exposureCents: mine ? opportunity.peakFundingCents : null,
      contributionPerSaleCents:
        mine && opportunity.priceCents !== null && opportunity.peakFundingCents !== null
          ? opportunity.priceCents - opportunity.peakFundingCents
          : null,
      currency: opportunity.currency,
      tasks: mine ? tasks : [],
      blockers: mine ? blockers : [],
      next: mine ? nextAction(tasks) : null,
    });
  }

  const totals = await totalsByKind({ projectId, currency: mode.currency });
  const settledCents = totals.SETTLEMENT ?? 0;
  const paidCents = Math.max(0, (totals.CUSTOMER_PAYMENT ?? 0) - (totals.REFUND ?? 0));
  const research = await getDb().get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM research_orchestrations
      WHERE project_id = ? AND status NOT IN ('COMPLETE', 'COMPLETE_WITH_GAPS', 'FAILED', 'CANCELLED', 'NEEDS_HUMAN')`,
    [projectId],
  );
  const order = (stage: PipelineStage): number => -PIPELINE_STAGES.indexOf(stage);
  views.sort((a, b) => order(a.stage) - order(b.stage) || (a.createdAt < b.createdAt ? -1 : 1));

  return {
    counts,
    labels: PIPELINE_STAGE_LABELS,
    jobs: views,
    qualifiedWithoutJob,
    settledCents: viewer.owner ? settledCents : 0,
    paidUnsettledCents: viewer.owner ? Math.max(0, paidCents - settledCents) : 0,
    currency: mode.currency,
    researchInFlight: Number(research?.n ?? 0),
    authority: {
      live: [...authority.values()].some((one) => one.ok),
      allowedActions: AUTHORITY_ACTIONS.filter((a) => authority.get(a)?.ok),
    },
    providers: PROVIDER_CAPABILITIES.map((id) => {
      const reading = capabilities.get(id);
      return { id, state: reading?.state ?? 'UNKNOWN', nextStep: reading?.state === 'PRESENT' ? null : reading?.definition?.requires ?? null };
    }),
  };
}
