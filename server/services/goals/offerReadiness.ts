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
import { goalSpendingRefusal, spendingReads, type SpendingReads } from './spending.ts';

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

/**
 * What one read shares across the openings it decides (finding F5).
 *
 * The commercial grant and the execution policy are facts about a *project* at
 * one instant, not about an opening: five `checkCommercialAuthority` calls and
 * a policy read per opening made a person's goals read cost goals × openings ×
 * ten queries. A context reads each project's five grants and its policy once,
 * and every opening of that project in the same read is decided against the
 * same answer. It is scoped to one read at one `now` and is never kept beyond
 * it, so a grant withdrawn a second ago is read again by the next read.
 */
export interface OfferReadingContext {
  readonly at: string;
  authorityFor(projectId: string): Promise<Record<ExternalAction, PermissionReading>>;
  policyFor(projectId: string): Promise<GoalExecutionPolicy>;
  /** The goal-spending rows, read once for every opening decided in this read. */
  readonly spending: SpendingReads;
}

/** One read's context; build one per read, never hold one across reads. */
export function offerReadingContext(now: Date = new Date()): OfferReadingContext {
  const at = now.toISOString();
  const authorities = new Map<string, Promise<Record<ExternalAction, PermissionReading>>>();
  const policies = new Map<string, Promise<GoalExecutionPolicy>>();
  return {
    at,
    spending: spendingReads(now),
    authorityFor(projectId) {
      let found = authorities.get(projectId);
      if (!found) {
        found = (async () => {
          const decisions = await Promise.all(
            EXTERNAL_ACTION_LIST.map((action) => checkCommercialAuthority({ projectId, action: EXTERNAL_ACTIONS[action], at })),
          );
          const authority = {} as Record<ExternalAction, PermissionReading>;
          EXTERNAL_ACTION_LIST.forEach((action, i) => {
            const d = decisions[i]!;
            authority[action] = { ok: d.ok, reason: d.reason };
          });
          return authority;
        })();
        authorities.set(projectId, found);
      }
      return found;
    },
    policyFor(projectId) {
      let found = policies.get(projectId);
      if (!found) {
        found = executionPolicyForProject(projectId, now);
        policies.set(projectId, found);
      }
      return found;
    },
  };
}

/** Reads one opening's rows and decides. Writes nothing. */
export async function offerReadinessFor(
  opportunity: CashOpportunity,
  now: Date = new Date(),
  context: OfferReadingContext = offerReadingContext(now),
): Promise<OfferReadiness> {
  const [policy, authority, facts, spendingRefusal] = await Promise.all([
    context.policyFor(opportunity.projectId),
    context.authorityFor(opportunity.projectId),
    cardFactsFor(opportunity.id),
    goalSpendingRefusal({ opportunity, neededCents: opportunity.peakFundingCents ?? 0, now, reads: context.spending }),
  ]);
  const testFirstPlay = isTestFirstPlay(opportunity);
  const required = qualificationKeys(opportunity.opportunitySignal ?? null, policy === 'SQUEEZE' ? false : testFirstPlay, policy);
  const card = cashEngineCard({ opportunity, facts, now: now.toISOString() });
  const answered = new Set(card.entries.filter((e) => e.value !== null).map((e) => e.key as string));
  const recipient = recipientFromChannel(opportunity.reachableChannel);
  const channel: PermissionReading = recipient.ok ? { ok: true, reason: 'one published address' } : { ok: false, reason: recipient.reason };

  return decideOfferReadiness({ policy, required, answered, testFirstPlay, authority, spendingRefusal, channel });
}

/** Opening states whose offer is no longer a question. */
export const SETTLED_OPENING_STATES: ReadonlySet<string> = new Set(['ARCHIVED', 'DECLINED', 'COLLECTED']);

/**
 * Every live opening a goal pursues, each decided independently. Writes
 * nothing. A caller that already holds the openings (the goals read) passes
 * them, with its context, so nothing is read twice.
 */
export async function offerReadinessForGoal(
  goalId: string,
  now: Date = new Date(),
  options: { context?: OfferReadingContext; openings?: readonly CashOpportunity[] } = {},
): Promise<{ opportunityId: string; readiness: OfferReadiness }[]> {
  const context = options.context ?? offerReadingContext(now);
  let openings = options.openings;
  if (!openings) {
    const found: CashOpportunity[] = [];
    for (const link of await listLinks(goalId)) {
      if (link.kind !== 'OPPORTUNITY') continue;
      const opportunity = await getOpportunity(link.ref);
      if (opportunity) found.push(opportunity);
    }
    openings = found;
  }
  const live = openings.filter((one) => !SETTLED_OPENING_STATES.has(one.state));
  return Promise.all(live.map(async (opportunity) => ({ opportunityId: opportunity.id, readiness: await offerReadinessFor(opportunity, now, context) })));
}
