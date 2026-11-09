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
import {
  heldCentsForProject,
  listAuthorities,
  liveAuthority,
} from '../../repos/cashAuthority.ts';
import { recordEvent } from '../../repos/events.ts';
import type { CashAuthority, EventType } from '../../domain/types.ts';

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
  /**
   * Have the Software Factory build the bounded test a READY_TO_TEST card
   * declares it needs, inside the repository and paths a person already
   * onboarded for this project. It spends nothing: the Factory runs on the
   * fixed subscription. It merges nothing, deploys nothing and contacts
   * nobody — the pull request stays a person's to merge.
   */
  'BUILD_A_TEST',
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

/* ------------------------------------------------------------------------- */
/* Graduated authority: consequence class, judged on the action path          */
/* ------------------------------------------------------------------------- */

/**
 * How much an action can hurt, in four steps. The class decides what kind of
 * authority it needs; it is the existing grant that supplies it, so this adds
 * a way of reading the permission system and no second policy engine.
 */
export const CONSEQUENCE_CLASSES = [
  /** Reading, analysing, drafting, reversible state inside authorized scope. */
  'INTERNAL',
  /** Factory coding, tests, merges and deploys under the release rules. */
  'STANDING_GRANT_ENGINEERING',
  /** An authenticated operation inside one account's own permissions. */
  'THIRD_PARTY_AUTHENTICATED',
  /** Outreach, money, contracts, publishing, accounts: a person's authority. */
  'EXTERNALLY_CONSEQUENTIAL',
] as const;

export type ConsequenceClass = (typeof CONSEQUENCE_CLASSES)[number];

const INTERNAL_ACTIONS = [
  'READ_PUBLIC_SOURCE',
  'READ_ONLY_ANALYSIS',
  'PARSE',
  'NON_PRODUCTION_EXPERIMENT',
  'CALCULATE',
  'DEDUPLICATE',
  'DESIGN_METHOD',
  'GENERATE_BENCHMARK',
  'REVERSIBLE_STATE_CHANGE',
  'DRAFT_MESSAGE',
  /** Looking at a portal or site. Never approval to act through it. */
  'VIEW_PORTAL',
  'LEARN_FROM_SITE',
] as const;

const ENGINEERING_ACTIONS = ['FACTORY_CODE', 'FACTORY_TEST', 'FACTORY_MERGE', 'FACTORY_DEPLOY', 'BUILD_A_TEST'] as const;

const THIRD_PARTY_ACTIONS = ['AUTHENTICATED_READ', 'AUTHENTICATED_OPERATION'] as const;

/** Consequential acts that no commercial grant lists today; each is still a person's decision. */
const OTHER_CONSEQUENTIAL_ACTIONS = [
  'SEND_OUTREACH',
  'SUBMIT_FORM',
  'SUBMIT_BID',
  'SIGN_AGREEMENT',
  'INITIATE_PAYMENT',
  'MOVE_FUNDS',
  'CREATE_ACCOUNT',
  'SCRAPE_PROTECTED',
  'GRANT_ACCESS',
  'CHANGE_WEBSITE',
] as const;

/** The acts whose size is a sum of money, so a missing amount is a refusal. */
const SPENDING_ACTIONS: readonly string[] = [
  'SPEND_FROM_ALLOWANCE',
  'ENGAGE_CONTRACTOR',
  'PURCHASE_TOOL_OR_DATA',
  'RUN_PAID_TEST',
  'INITIATE_PAYMENT',
  'MOVE_FUNDS',
];

/** An exact-match closed map, built once from the lists above. */
const ACTION_CLASS: ReadonlyMap<string, ConsequenceClass> = new Map<string, ConsequenceClass>([
  ...INTERNAL_ACTIONS.map((a) => [a, 'INTERNAL'] as const),
  ...ENGINEERING_ACTIONS.map((a) => [a, 'STANDING_GRANT_ENGINEERING'] as const),
  ...THIRD_PARTY_ACTIONS.map((a) => [a, 'THIRD_PARTY_AUTHENTICATED'] as const),
  ...COMMERCIAL_ACTIONS.filter((a) => a !== 'BUILD_A_TEST').map((a) => [a, 'EXTERNALLY_CONSEQUENTIAL'] as const),
  ...OTHER_CONSEQUENTIAL_ACTIONS.map((a) => [a, 'EXTERNALLY_CONSEQUENTIAL'] as const),
  ...ALWAYS_PROHIBITED_COMMERCIAL.map((a) => [a, 'EXTERNALLY_CONSEQUENTIAL'] as const),
]);

/** The class of a named action, or null when it is not one this Brain knows. */
export function classifyAction(action: string): ConsequenceClass | null {
  return ACTION_CLASS.get(action) ?? null;
}

/** How the action reaches the world. The browser is a path, not an exemption. */
export type ActionPath = 'API' | 'BROWSER' | 'INTERNAL';

/** What the caller already holds toward the action: reading, or real authority. */
export type AccessKind = 'READ_ONLY' | 'OPERATE';

export interface AuthorityLedgerRecord {
  kind: 'AUTHORITY_DECISION';
  projectId: string;
  action: string;
  consequenceClass: ConsequenceClass | null;
  path: ActionPath;
  /** What Brain did, versus what it only proposed. */
  disposition: 'PERFORMED' | 'PROPOSED' | 'REFUSED';
  /** Machine-readable cause; a person's words are in `reason`. */
  cause:
    | 'ALLOWED'
    | 'UNKNOWN_ACTION'
    | 'READ_ONLY_GRANT'
    | 'PROHIBITED'
    | 'EMERGENCY_STOP'
    | 'REVOKED'
    | 'NO_AUTHORITY'
    | 'EXPIRED_OR_NOT_STARTED'
    | 'NOT_COVERED'
    | 'AMOUNT_UNKNOWN'
    | 'OVER_PER_ACTION_CEILING'
    | 'OVER_COMMITTED_CEILING'
    | 'RELEASE_ENVELOPE';
  policyVersion: number | null;
  amountCents: number | null;
  at: string;
}

export interface ActionDecision {
  ok: boolean;
  consequenceClass: ConsequenceClass | null;
  reason: string;
  /** The single smallest grant that would change a refusal, or null when none can. */
  neededApproval: { action: string; projectId: string; description: string } | null;
  /** On a stop or revocation: what stays owed and what may still proceed. */
  obligations: { heldCents: number } | null;
  remainingSafeWork: ConsequenceClass[];
  /** Ready for `project_events`. Carries no credential and no free text from a caller. */
  ledger: AuthorityLedgerRecord;
}

export interface JudgeInput {
  projectId: string;
  action: string;
  path?: ActionPath;
  /** READ_ONLY never reaches past INTERNAL, on any path. */
  access?: AccessKind;
  /** PROPOSE records a draft; only PERFORM is an effect. */
  mode?: 'PERFORM' | 'PROPOSE';
  amountCents?: number | null;
  /** Set by the owner's stop control, read from its row — never by the action's caller. */
  emergencyStop?: boolean;
  /** A fact read from the release grant's envelope, for engineering actions. */
  releaseEnvelopeAllows?: boolean;
  at?: string;
}

export interface JudgeState {
  authority: CashAuthority | null;
  /** The newest grant for the project was revoked, and no live one replaced it. */
  revoked: boolean;
  heldCents: number;
}

const SAFE_WORK: ConsequenceClass[] = ['INTERNAL', 'STANDING_GRANT_ENGINEERING'];

/**
 * The pure judgment: a closed action, a grant row and a few facts in; a decision
 * and its ledger record out. Deny by default; an unknown value is never read as
 * a favourable one.
 */
export function judgeAction(input: JudgeInput, state: JudgeState): ActionDecision {
  const at = input.at ?? new Date().toISOString();
  const path = input.path ?? 'INTERNAL';
  const klass = classifyAction(input.action);
  const amount = typeof input.amountCents === 'number' && Number.isFinite(input.amountCents) ? input.amountCents : null;

  const finish = (
    ok: boolean,
    cause: AuthorityLedgerRecord['cause'],
    reason: string,
    needs: ActionDecision['neededApproval'] = null,
  ): ActionDecision => {
    const proposed = ok && input.mode === 'PROPOSE';
    return {
      ok,
      consequenceClass: klass,
      reason,
      neededApproval: ok ? null : needs,
      obligations: !ok && (cause === 'REVOKED' || cause === 'EMERGENCY_STOP') ? { heldCents: state.heldCents } : null,
      remainingSafeWork: !ok && (cause === 'REVOKED' || cause === 'EMERGENCY_STOP') ? SAFE_WORK : [],
      ledger: {
        kind: 'AUTHORITY_DECISION',
        projectId: input.projectId,
        action: klass ? input.action : 'UNKNOWN',
        consequenceClass: klass,
        path,
        disposition: !ok ? 'REFUSED' : proposed ? 'PROPOSED' : 'PERFORMED',
        cause,
        policyVersion: state.authority?.policyVersion ?? null,
        amountCents: amount,
        at,
      },
    };
  };
  const ask = (description: string) => ({ action: input.action, projectId: input.projectId, description });

  if (!klass) {
    return finish(false, 'UNKNOWN_ACTION', `"${input.action}" is not an action this Brain knows how to authorize`);
  }
  // Reading, analysing and drafting never need a grant, and a stopped or
  // revoked grant never stops them: routine research continues.
  if (klass === 'INTERNAL') return finish(true, 'ALLOWED', 'internal work needs no commercial authority');

  // A draft of anything is internal work; only the effect is consequential.
  if (input.mode === 'PROPOSE') return finish(true, 'ALLOWED', 'proposed only; nothing was performed');

  if ((ALWAYS_PROHIBITED_COMMERCIAL as readonly string[]).includes(input.action)) {
    return finish(false, 'PROHIBITED', `${input.action} can never be authorized`);
  }
  if (input.access === 'READ_ONLY') {
    return finish(
      false,
      'READ_ONLY_GRANT',
      `read-only access does not authorize ${input.action}${path === 'BROWSER' ? ' through a browser' : ''}`,
      ask(`authority to ${input.action}, separate from the read-only access already held`),
    );
  }
  if (input.emergencyStop) {
    return finish(false, 'EMERGENCY_STOP', 'emergency stop is on: risky mutations are paused');
  }
  if (state.revoked && !state.authority) {
    return finish(false, 'REVOKED', 'the standing authority was revoked', ask(`renewed authority covering ${input.action}`));
  }
  if (klass === 'STANDING_GRANT_ENGINEERING' && input.action !== 'BUILD_A_TEST') {
    return input.releaseEnvelopeAllows === true
      ? finish(true, 'ALLOWED', 'within the release approval envelope')
      : finish(false, 'RELEASE_ENVELOPE', 'the release approval envelope does not allow this', ask(`release approval for ${input.action}`));
  }

  const authority = state.authority;
  if (!authority) {
    return finish(false, 'NO_AUTHORITY', 'no standing commercial authority exists for this project', ask(`a standing grant covering ${input.action}`));
  }
  if (authority.startsAt > at || (authority.expiresAt !== null && authority.expiresAt <= at)) {
    return finish(false, 'EXPIRED_OR_NOT_STARTED', 'the standing authority is not in force', ask(`renewed authority covering ${input.action}`));
  }
  if (authority.prohibitions.includes(input.action)) {
    return finish(false, 'PROHIBITED', `the commercial authority prohibits ${input.action}`);
  }
  if (!authority.allowedActions.includes(input.action)) {
    return finish(false, 'NOT_COVERED', `the commercial authority does not cover ${input.action}`, ask(`add ${input.action} to the standing grant`));
  }
  if (SPENDING_ACTIONS.includes(input.action)) {
    if (amount === null || amount < 0) {
      return finish(false, 'AMOUNT_UNKNOWN', 'the amount is not stated, so it cannot be judged against a ceiling');
    }
    if (amount > authority.maxPerActionCents) {
      return finish(false, 'OVER_PER_ACTION_CEILING', 'the amount is over the single-commitment ceiling', ask(`a per-action ceiling of at least ${amount} cents`));
    }
    if (state.heldCents + amount > authority.maxCommittedCents) {
      return finish(false, 'OVER_COMMITTED_CEILING', 'the amount would exceed what may be committed at once', ask(`a committed ceiling of at least ${state.heldCents + amount} cents`));
    }
  }
  return finish(true, 'ALLOWED', 'within the standing commercial authority');
}

/**
 * Judge an action against the live rows. This is the one call every action path
 * — an API, a browser automation, a worker — makes before an effect.
 */
export async function decideAction(input: JudgeInput): Promise<ActionDecision> {
  const decision = await judgeLive(input);
  return recordDecision(input, decision);
}

/**
 * The event type of a decision. `project_events.event_type` is unconstrained
 * text and append-only; the ledger record is its payload, which carries no
 * credential and no caller free text.
 */
export const AUTHORITY_DECISION_EVENT = 'AUTHORITY_DECISION' as EventType;

/**
 * Append the decision to `project_events`, so what Brain performed, proposed and
 * was refused is inspectable after the fact. An action that would be an effect
 * is not allowed on a ledger that could not be written: no unrecorded mutation.
 * Internal work never needs a grant, so a failed write cannot stop research.
 */
async function recordDecision(input: JudgeInput, decision: ActionDecision): Promise<ActionDecision> {
  try {
    await recordEvent({
      projectId: input.projectId,
      entityType: 'authority',
      entityId: decision.ledger.action,
      eventType: AUTHORITY_DECISION_EVENT,
      payload: { ...decision.ledger, ok: decision.ok, neededApproval: decision.neededApproval, obligations: decision.obligations },
    });
  } catch {
    if (decision.consequenceClass !== 'INTERNAL' && decision.ok && input.mode !== 'PROPOSE') {
      return {
        ...decision,
        ok: false,
        reason: 'the authority ledger could not be written, so the effect was not allowed',
        ledger: { ...decision.ledger, disposition: 'REFUSED' },
      };
    }
  }
  return decision;
}

async function judgeLive(input: JudgeInput): Promise<ActionDecision> {
  const klass = classifyAction(input.action);
  if (klass === 'INTERNAL' || !klass) return judgeAction(input, { authority: null, revoked: false, heldCents: 0 });
  const authority = await liveAuthority(input.projectId, input.at);
  let revoked = false;
  if (!authority) {
    const all = await listAuthorities(input.projectId);
    revoked = all[0]?.state === 'REVOKED';
  }
  const held = await heldCentsForProject(input.projectId, authority?.currency);
  return judgeAction(input, { authority, revoked, heldCents: held });
}
