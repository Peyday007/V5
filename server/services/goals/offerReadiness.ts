/**
 * Whether an opening may be offered now, and exactly which external action a
 * missing permission stops (PORT-05; §16, §38, §95).
 *
 * The owner's order (S-0065): under SQUEEZE an opening is offered as soon as it
 * is authorized and offerable, with no mandatory preliminary market test;
 * research and sales run in parallel; commercial activity respects the
 * customer-contact, invoicing, contracting, spending and payment permissions,
 * the channel rules and the goal's own financial limits; and a missing
 * permission stops *that external action* — never independent research,
 * construction, modelling or software work.
 *
 * This decides; it owns no authority. Every permission is read from the
 * existing owner of it and nothing is re-implemented:
 *
 *   - the commercial grant: `checkCommercialAuthority` (`cash/authority.ts`);
 *   - the goal's money limits: `goalSpendingRefusal` (`goals/spending.ts`);
 *   - the channel rule for reaching a buyer: `recipientFromChannel`
 *     (`cash/outreach.ts`) — exactly one published address or no contact;
 *   - the execution policy and its qualification: `executionPolicyForProject`
 *     (`goals/policy.ts`) and `qualificationKeys` (`cash/tier.ts`), which
 *     reads `SQUEEZE_QUALIFICATION` (`domain/goalPolicy.ts`).
 *
 * `decideOfferReadiness` is pure; `offerReadinessFor` / `offerReadinessForGoal`
 * only read rows and then call it.
 */
import type { GoalExecutionPolicy } from '../../domain/goalPolicy.ts';
import type { CashOpportunity } from '../../domain/types.ts';
import { checkCommercialAuthority, type CommercialAction } from '../cash/authority.ts';
import { recipientFromChannel } from '../cash/outreach.ts';
import { qualificationKeys, isTestFirstPlay } from '../cash/tier.ts';
import { cashEngineCard } from '../cash/engineCard.ts';
import { cardFactsFor } from '../../repos/cashCardFacts.ts';
import { listLinks } from '../../repos/register.ts';
import { getOpportunity } from '../../repos/cashPortfolio.ts';
import { executionPolicyForProject } from './policy.ts';
import { goalSpendingRefusal } from './spending.ts';

/** The external commercial actions a sale needs, each mapped to the grant that permits it. */
export const EXTERNAL_ACTIONS = {
  CONTACT: 'CONTACT_BUYER',
  INVOICE: 'QUOTE_AND_INVOICE',
  CONTRACT: 'ENGAGE_CONTRACTOR',
  SPEND: 'SPEND_FROM_ALLOWANCE',
  PAYMENT: 'ACCEPT_PAYMENT',
} as const satisfies Record<string, CommercialAction>;
export type ExternalAction = keyof typeof EXTERNAL_ACTIONS;
export const EXTERNAL_ACTION_LIST = Object.keys(EXTERNAL_ACTIONS) as ExternalAction[];

/** Work that touches nobody outside Brain: never stopped by a commercial permission. */
export const INTERNAL_WORK = ['RESEARCH', 'CONSTRUCTION', 'MODELLING', 'SOFTWARE'] as const;
export type InternalWork = (typeof INTERNAL_WORK)[number];

export interface PermissionReading {
  ok: boolean;
  reason: string;
}

export interface OfferReadinessInput {
  policy: GoalExecutionPolicy;
  /** The qualification keys this opening must answer under the policy (`qualificationKeys`). */
  required: readonly string[];
  /** The keys its evidence card answers. */
  answered: ReadonlySet<string>;
  /** Whether the evidence-first path demands a bounded test before selling (a test-first play). */
  testFirstPlay: boolean;
  /** `checkCommercialAuthority` per external action. */
  authority: Record<ExternalAction, PermissionReading>;
  /** `goalSpendingRefusal` for what this opening would tie up; null when it fits. */
  spendingRefusal: string | null;
  /** `recipientFromChannel` on the opening's published channel. */
  channel: PermissionReading;
}

export interface ActionReading {
  action: ExternalAction;
  grant: CommercialAction;
  may: boolean;
  /** Null when it may go. Otherwise what stops exactly this action and what would allow it. */
  blocker: { reason: string; allowedBy: string } | null;
}

export interface OfferReadiness {
  policy: GoalExecutionPolicy;
  /** Every required qualification key is answered. */
  offerable: boolean;
  missing: string[];
  /** A bounded market test is required before an offer. Never under SQUEEZE. */
  marketTestRequired: boolean;
  /** The offer may go out now: offerable, no test first, and the buyer can be contacted. */
  offerNow: boolean;
  actions: ActionReading[];
  /** The two lanes of one opening; both may be live at once. */
  lanes: { research: 'RUNNABLE'; sales: 'RUNNABLE' | 'BLOCKED' | 'NOT_YET'; salesBecause: string };
  /** Internal work is runnable whatever the permissions say. */
  internal: { work: InternalWork; runnable: true }[];
}

function blockerFor(action: ExternalAction, input: OfferReadinessInput): ActionReading['blocker'] {
  const grant = EXTERNAL_ACTIONS[action];
  const auth = input.authority[action];
  if (!auth.ok) return { reason: auth.reason, allowedBy: `a live commercial authority for this project that allows ${grant}` };
  if (action === 'CONTACT' && !input.channel.ok) {
    return { reason: input.channel.reason, allowedBy: 'a buyer-published channel naming exactly one email address (the channel rule)' };
  }
  if (action === 'SPEND' && input.spendingRefusal) {
    return { reason: input.spendingRefusal, allowedBy: "room inside the goal's spending limits (total, before proof, per week) as its owner set them" };
  }
  return null;
}

/** Pure: same readings, same answer. */
export function decideOfferReadiness(input: OfferReadinessInput): OfferReadiness {
  const missing = input.required.filter((k) => !input.answered.has(k));
  const offerable = missing.length === 0;
  // SQUEEZE sells; it never makes a test a precondition of an offer (domain/goalPolicy.ts).
  const marketTestRequired = input.policy === 'SQUEEZE' ? false : input.testFirstPlay;
  const actions: ActionReading[] = EXTERNAL_ACTION_LIST.map((action) => {
    const blocker = blockerFor(action, input);
    return { action, grant: EXTERNAL_ACTIONS[action], may: blocker === null, blocker };
  });
  const contact = actions.find((a) => a.action === 'CONTACT')!;
  const offerNow = offerable && !marketTestRequired && contact.may;
  let sales: OfferReadiness['lanes']['sales'];
  let salesBecause: string;
  if (!offerable) {
    sales = 'NOT_YET';
    salesBecause = `the offer needs ${missing.join(', ')} answered; research runs meanwhile`;
  } else if (marketTestRequired) {
    sales = 'NOT_YET';
    salesBecause = 'this evidence-first opening is a test-first play, so a bounded test comes before the offer';
  } else if (!contact.may) {
    sales = 'BLOCKED';
    salesBecause = `contacting the buyer is stopped: ${contact.blocker!.reason}`;
  } else {
    sales = 'RUNNABLE';
    salesBecause = 'offerable and the buyer may be contacted; the offer goes out beside the research';
  }
  return {
    policy: input.policy,
    offerable,
    missing,
    marketTestRequired,
    offerNow,
    actions,
    lanes: { research: 'RUNNABLE', sales, salesBecause },
    internal: INTERNAL_WORK.map((work) => ({ work, runnable: true as const })),
  };
}

/* ------------------------------------------------------------------ readers */

/** Reads one opening's rows and decides. Writes nothing. */
export async function offerReadinessFor(opportunity: CashOpportunity, now: Date = new Date()): Promise<OfferReadiness> {

  const policy = await executionPolicyForProject(opportunity.projectId, now);
  const testFirstPlay = isTestFirstPlay(opportunity);
  const required = qualificationKeys(opportunity.opportunitySignal ?? null, policy === 'SQUEEZE' ? false : testFirstPlay, policy);
  const card = cashEngineCard({ opportunity, facts: await cardFactsFor(opportunity.id), now: now.toISOString() });
  const answered = new Set(card.entries.filter((e) => e.value !== null).map((e) => e.key as string));

  const authority = {} as Record<ExternalAction, PermissionReading>;
  for (const action of EXTERNAL_ACTION_LIST) {
    const d = await checkCommercialAuthority({ projectId: opportunity.projectId, action: EXTERNAL_ACTIONS[action], at: now.toISOString() });
    authority[action] = { ok: d.ok, reason: d.reason };
  }
  const recipient = recipientFromChannel(opportunity.reachableChannel);
  const channel: PermissionReading = recipient.ok ? { ok: true, reason: 'one published address' } : { ok: false, reason: recipient.reason };
  const spendingRefusal = await goalSpendingRefusal({ opportunity, neededCents: opportunity.peakFundingCents ?? 0, now });

  return decideOfferReadiness({ policy, required, answered, testFirstPlay, authority, spendingRefusal, channel });
}

/** Every live opening a goal pursues, each decided independently. Writes nothing. */
export async function offerReadinessForGoal(goalId: string, now: Date = new Date()): Promise<{ opportunityId: string; readiness: OfferReadiness }[]> {
  const out: { opportunityId: string; readiness: OfferReadiness }[] = [];
  for (const link of await listLinks(goalId)) {
    if (link.kind !== 'OPPORTUNITY') continue;
    const opportunity = await getOpportunity(link.ref);
    if (!opportunity || opportunity.state === 'ARCHIVED' || opportunity.state === 'DECLINED' || opportunity.state === 'COLLECTED') continue;
    out.push({ opportunityId: opportunity.id, readiness: await offerReadinessFor(opportunity, now) });
  }
  return out;
}

/* ------------------------------------------------------------ acting on it */

/*
 * Readiness was a description on the goal view; nothing that sends an offer
 * read it (review finding F3). This is where it becomes the trigger, and it
 * still owns no authority and sends nothing itself:
 *
 *   - an opening that may be offered now and is not yet READY is readied
 *     through `markReady` (`cash/opportunities.ts`), the one gate that moves a
 *     piece to READY, so its offer enters the sender this pass instead of
 *     waiting on a market test SQUEEZE never requires;
 *   - every opening that may be offered now is put first in the order the
 *     sender reaches buyers (`salesOrderForProject` → `advanceWithinAuthority`
 *     in `cash/operate.ts`), which re-checks the grant, the capability, the
 *     channel and the send gate itself before anything leaves;
 *   - an opening that may not is neither readied nor promoted, and the goal
 *     records the exact external action stopped and what would allow it —
 *     while research, construction, modelling and software stay runnable.
 *
 * Brain readies nothing in a project whose sprint is winding down (§30,
 * invariant 40): that is the sender's own rule, read from the same row.
 */

/** Opening states the sender can still offer from. */
const PRE_READY: ReadonlySet<string> = new Set(['DISCOVERED', 'EVIDENCE_CARD']);
const OFFERABLE_STATES: ReadonlySet<string> = new Set(['DISCOVERED', 'EVIDENCE_CARD', 'READY']);

export type OfferAct = 'READIED' | 'OFFER_FIRST' | 'STOPPED' | 'READY_REFUSED' | 'SPRINT_NOT_ACTIVE';

export interface OfferActReading {
  goalId: string;
  projectId: string;
  opportunityId: string;
  act: OfferAct;
  /** The external action stopped and the permission that stops it, when stopped. */
  stopped: { action: ExternalAction | 'OFFER'; reason: string; allowedBy: string } | null;
  because: string;
}

export interface OfferActPorts {
  /** The live openings a goal pursues and each one's readiness. */
  readinessForGoal: (goalId: string, now: Date) => Promise<{ opportunityId: string; readiness: OfferReadiness }[]>;
  stateOf: (opportunityId: string) => Promise<{ state: string; projectId: string } | null>;
  sprintActive: (projectId: string) => Promise<boolean>;
  markReady: (opportunityId: string) => Promise<{ ok: boolean; reason: string }>;
  /** The newest decision key this goal recorded for the opening, or null. */
  lastDecision: (goalId: string) => Promise<Map<string, string>>;
  record: (input: { goalId: string; opportunityId: string; key: string; reading: OfferActReading }) => Promise<void>;
}

/** Openings the goal tick found may be offered now, per project, in the order found. */
const offerFirstByProject = new Map<string, string[]>();

/** What the sender reaches first in a project: openings a live goal may offer now. */
export function offersReadyFirst(projectId: string): string[] {
  return [...(offerFirstByProject.get(projectId) ?? [])];
}

/** Tests. */
export function forgetOffersReadyFirst(): void {
  offerFirstByProject.clear();
}

function stopOf(readiness: OfferReadiness): OfferActReading['stopped'] {
  if (!readiness.offerable) {
    return { action: 'OFFER', reason: `the offer needs ${readiness.missing.join(', ')} answered`, allowedBy: 'those facts on the opening card' };
  }
  if (readiness.marketTestRequired) {
    return { action: 'OFFER', reason: 'a test-first play under an evidence-first goal', allowedBy: 'a bounded test, or a SQUEEZE policy on the goal' };
  }
  const contact = readiness.actions.find((a) => a.action === 'CONTACT');
  if (contact && contact.blocker) return { action: 'CONTACT', reason: contact.blocker.reason, allowedBy: contact.blocker.allowedBy };
  return null;
}

/**
 * Act on each active goal's offer readiness. Idempotent by rows: readying is
 * the existing transition (a second call is refused as past ready), the order
 * is replaced whole each pass, and a decision is recorded only when it changed.
 * One opening failing never stops the others.
 */
export async function actOnOfferReadiness(
  goals: readonly { id: string; lifecycle: string }[],
  ports: OfferActPorts,
  now: Date = new Date(),
): Promise<{ acted: OfferActReading[]; failed: { goalId: string; opportunityId: string | null; error: string }[] }> {
  const acted: OfferActReading[] = [];
  const failed: { goalId: string; opportunityId: string | null; error: string }[] = [];
  const first = new Map<string, string[]>();
  const sprint = new Map<string, boolean>();
  for (const goal of goals) {
    if (goal.lifecycle !== 'ACTIVE') continue;
    let readings: { opportunityId: string; readiness: OfferReadiness }[];
    let last: Map<string, string>;
    try {
      readings = await ports.readinessForGoal(goal.id, now);
      if (readings.length === 0) continue;
      last = await ports.lastDecision(goal.id);
    } catch (error) {
      failed.push({ goalId: goal.id, opportunityId: null, error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) });
      continue;
    }
    for (const { opportunityId, readiness } of readings) {
      try {
        const row = await ports.stateOf(opportunityId);
        if (!row || !OFFERABLE_STATES.has(row.state)) continue;
        let reading: OfferActReading;
        const stopped = readiness.offerNow ? null : stopOf(readiness);
        if (!readiness.offerNow) {
          reading = { goalId: goal.id, projectId: row.projectId, opportunityId, act: 'STOPPED', stopped, because: readiness.lanes.salesBecause };
        } else {
          if (!sprint.has(row.projectId)) sprint.set(row.projectId, await ports.sprintActive(row.projectId));
          if (!sprint.get(row.projectId)) {
            reading = { goalId: goal.id, projectId: row.projectId, opportunityId, act: 'SPRINT_NOT_ACTIVE', stopped: null, because: "offerable and authorized, but the project's sprint is not running, so Brain starts no new offer" };
          } else {
            let act: OfferAct = 'OFFER_FIRST';
            let because = 'offerable and the buyer may be contacted; the sender reaches it first';
            if (PRE_READY.has(row.state)) {
              const ready = await ports.markReady(opportunityId);
              if (ready.ok) {
                act = 'READIED';
                because = 'offerable and authorized with no market test first: readied, and the sender reaches it first';
              } else {
                act = 'READY_REFUSED';
                because = `offerable on the goal's reading, but marking it ready was refused: ${ready.reason}`;
              }
            }
            if (act !== 'READY_REFUSED') {
              const list = first.get(row.projectId) ?? [];
              if (!list.includes(opportunityId)) list.push(opportunityId);
              first.set(row.projectId, list);
            }
            reading = { goalId: goal.id, projectId: row.projectId, opportunityId, act, stopped: null, because };
          }
        }
        acted.push(reading);
        const key = `${reading.act}:${reading.stopped ? `${reading.stopped.action}:${reading.stopped.reason}` : ''}`;
        if (last.get(opportunityId) !== key) await ports.record({ goalId: goal.id, opportunityId, key, reading });
      } catch (error) {
        failed.push({ goalId: goal.id, opportunityId, error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) });
      }
    }
  }
  offerFirstByProject.clear();
  for (const [projectId, ids] of first) offerFirstByProject.set(projectId, ids);
  return { acted, failed };
}

export const GOAL_OFFER_DECIDED = 'GOAL_OFFER_DECIDED';

/** The production ports: every one is the existing owner of what it reads or does. */
export async function productionOfferActPorts(): Promise<OfferActPorts> {
  const { getCashMode } = await import('../../repos/cashMode.ts');
  const { markReady } = await import('../cash/opportunities.ts');
  const { listWorkstreamEvents, recordWorkstreamEvent } = await import('../../repos/register.ts');
  return {
    readinessForGoal: offerReadinessForGoal,
    stateOf: async (id) => {
      const one = await getOpportunity(id);
      return one ? { state: one.state, projectId: one.projectId } : null;
    },
    sprintActive: async (projectId) => (await getCashMode(projectId))?.state === 'ACTIVE',
    markReady: async (id) => {
      const out = await markReady({ opportunityId: id, actorRef: 'BRAIN' });
      return { ok: out.ok, reason: out.ok ? out.message : out.reason };
    },
    lastDecision: async (goalId) => {
      const out = new Map<string, string>();
      for (const event of await listWorkstreamEvents(goalId, 200)) {
        if (event.kind !== GOAL_OFFER_DECIDED) continue;
        const detail = (event.detail ?? {}) as { opportunityId?: string; key?: string };
        if (detail.opportunityId && detail.key && !out.has(detail.opportunityId)) out.set(detail.opportunityId, detail.key);
      }
      return out;
    },
    record: async ({ goalId, opportunityId, key, reading }) => {
      const summary =
        reading.act === 'STOPPED' && reading.stopped
          ? `Offer stopped at ${reading.stopped.action}: ${reading.stopped.reason}. Allowed by ${reading.stopped.allowedBy}. Research continues.`
          : `Offer ${reading.act.toLowerCase().replace(/_/g, ' ')}: ${reading.because}.`;
      await recordWorkstreamEvent({
        workstreamId: goalId,
        kind: GOAL_OFFER_DECIDED,
        summary: summary.slice(0, 400),
        detail: { opportunityId, key, act: reading.act, stopped: reading.stopped, projectId: reading.projectId },
        actorRef: 'BRAIN',
      });
    },
  };
}
