/**
 * What Brain may do with somebody's money, and the closed set it is chosen
 * from.
 *
 * ---------------------------------------------------------------------------
 * Why this is not `russell_goals`
 * ---------------------------------------------------------------------------
 *
 * A 12A standing authority carries `ALWAYS_PROHIBITED`, and that list contains
 * `NEW_SPENDING`, `PURCHASE` and `CONTACT_PERSON`, with `max_external_spend`
 * fixed at zero. Those grants authorize reading published sources and nothing
 * else. Relaxing one to let a cash sprint buy a supplier's time would widen
 * **every research mission already running under it**, silently, which is why
 * the commercial grant is a separate row with a separate actor and separate
 * ceilings.
 *
 * Neither reads the other. A project may hold both; a research mission is still
 * refused any spending, and a commercial commitment still authorizes nothing
 * about what a fragment may cite.
 *
 * ---------------------------------------------------------------------------
 * Three properties, and each of them is what makes this safe rather than a
 * loophole
 * ---------------------------------------------------------------------------
 *
 * **The vocabulary is code.** `COMMERCIAL_ACTIONS` is a closed set matched
 * exactly. An action outside it refuses the whole grant at creation rather than
 * being stored and later compared against nothing — an unknown field refusing a
 * whole proposal, which is `proposal.ts`'s rule at a new subject.
 *
 * **Some things cannot be granted at all.** `ALWAYS_PROHIBITED_COMMERCIAL` is
 * unioned into every grant at creation rather than checked separately, so a
 * grant written by a script, a future screen or a migration cannot omit one by
 * forgetting. Removing an entry from it is a code change somebody reviews.
 *
 * **A model never decides.** Nothing in this module reads prose, and no caller
 * supplies the limits its own action is judged against: the ceilings come from
 * the row a person wrote, the action comes from a closed set, and the answer is
 * a pure comparison. §8's rule at the one place where breaking it would spend
 * real money.
 */
import { liveAuthority } from '../../repos/cashAuthority.ts';
import type { CashAuthority } from '../../domain/types.ts';

/**
 * Everything a commercial grant may authorize.
 *
 * Deliberately about *effects on the world* rather than about mechanisms: a
 * grant says Brain may issue an invoice, not that Brain may use Stripe. Which
 * tool executes it is an execution choice made later against what is actually
 * available, and binding the two here would turn a missing integration into a
 * missing authorization.
 */
export const COMMERCIAL_ACTIONS = [
  /** Commit part of the owner's own capital, inside the ceilings they set. */
  'SPEND_FROM_ALLOWANCE',
  /** Reach a named payer, through a channel the owner supplied. */
  'CONTACT_BUYER',
  /** Issue a quote or an invoice for a scope that is already agreed. */
  'QUOTE_AND_INVOICE',
  /** Commit contractor or supplier capacity against a named obligation. */
  'ENGAGE_CONTRACTOR',
  /** Buy a named tool, dataset or delivery component. */
  'PURCHASE_TOOL_OR_DATA',
  /** Spend on one bounded test whose purpose is to produce evidence. */
  'RUN_PAID_TEST',
  /** Record and accept a customer payment against an agreed scope. */
  'ACCEPT_PAYMENT',
] as const;

export type CommercialAction = (typeof COMMERCIAL_ACTIONS)[number];

export function isCommercialAction(value: unknown): value is CommercialAction {
  return typeof value === 'string' && (COMMERCIAL_ACTIONS as readonly string[]).includes(value);
}

/**
 * What no commercial grant may ever carry.
 *
 * `PAID_OVERAGE` is invariant 18 restated where it is most likely to be
 * forgotten: the subscription fleet is fixed and nothing here turns on paid
 * model usage. The rest are the acts whose damage is not contained by a
 * ceiling — a credential, an access change, something signed in somebody's
 * name, a filing, borrowed money, or another account's capital. A dollar limit
 * does not bound any of them.
 */
export const ALWAYS_PROHIBITED_COMMERCIAL = [
  'PAID_OVERAGE',
  'NEW_CREDENTIAL',
  'ACCESS_EXPANSION',
  'PERMISSION_CHANGE',
  'IDENTITY_BEARING_ACT',
  'LEGAL_FILING',
  'BORROW_OR_LEVERAGE',
  'SPEND_ANOTHER_ACCOUNTS_CAPITAL',
  'DEPLOY_TO_PRODUCTION',
  'PUBLISH_EXTERNALLY',
] as const;

export interface CommercialDecision {
  ok: boolean;
  authority: CashAuthority | null;
  /** Safe to show a person. Names the rule, never a credential or an id. */
  reason: string;
  policyVersion: number | null;
}

/**
 * May this project take this commercial action, right now, under a live grant?
 *
 * Deny by default and fail closed. No grant, an expired one, a not-yet-started
 * one, a revoked one, an unknown action, an unlisted one and a prohibited one
 * are all refusals, and none of them degrades to a weaker allowance.
 */
export async function checkCommercialAuthority(input: {
  projectId: string;
  action: string;
  at?: string;
}): Promise<CommercialDecision> {
  if (!isCommercialAction(input.action)) {
    return {
      ok: false,
      authority: null,
      reason: `"${input.action}" is not a commercial action this Brain knows how to authorize`,
      policyVersion: null,
    };
  }
  const authority = await liveAuthority(input.projectId, input.at);
  if (!authority) {
    return {
      ok: false,
      authority: null,
      reason: 'no standing commercial authority exists for this project',
      policyVersion: null,
    };
  }
  if (authority.prohibitions.includes(input.action)) {
    return {
      ok: false,
      authority,
      reason: `the commercial authority prohibits ${input.action}`,
      policyVersion: authority.policyVersion,
    };
  }
  if (!authority.allowedActions.includes(input.action)) {
    return {
      ok: false,
      authority,
      reason: `the commercial authority does not cover ${input.action}`,
      policyVersion: authority.policyVersion,
    };
  }
  return {
    ok: true,
    authority,
    reason: 'within the standing commercial authority',
    policyVersion: authority.policyVersion,
  };
}

/**
 * The grant, rendered as sentences the server composed.
 *
 * §24's rule, applied to money: a screen that paraphrased a permission would
 * eventually paraphrase it wrongly, so the words a person reads and the
 * contract the check enforces are built from one object. The client renders
 * these and composes none of its own.
 */
export function describeAuthority(authority: CashAuthority): string[] {
  const money = (cents: number): string =>
    `${authority.currency} ${(cents / 100).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  const lines = [
    `Brain may commit up to ${money(authority.maxCommittedCents)} of your money at any one ` +
      'time, and no more until something settles or you release it.',
    `No single commitment may be larger than ${money(authority.maxPerActionCents)}.`,
    `At most ${authority.maxConcurrent} ${
      authority.maxConcurrent === 1 ? 'opportunity' : 'opportunities'
    } may be executing at once.`,
  ];
  lines.push(
    authority.allowedActions.length === 0
      ? 'It authorizes no commercial action at all, so nothing can be committed under it.'
      : `It authorizes: ${authority.allowedActions.join(', ')}.`,
  );
  lines.push(
    'It can never authorize: ' + ALWAYS_PROHIBITED_COMMERCIAL.join(', ') + '.',
  );
  lines.push(
    authority.expiresAt
      ? `It stops on ${authority.expiresAt}, after which nothing new can be committed under it.`
      : 'It has no expiry, so withdrawing it is what ends it.',
  );
  return lines;
}
