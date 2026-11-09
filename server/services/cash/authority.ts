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
  listCommitments,
  liveAuthority,
} from '../../repos/cashAuthority.ts';
import { cashEventsOfKindInProject, recordCashEvent } from '../../repos/cashMode.ts';
import { needForKey, openNeedForKey } from '../../repos/cashPortfolio.ts';
import { closeNeed, raiseNeed } from './needs.ts';
import type { CashAuthority, CashNeed } from '../../domain/types.ts';

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
  /** Who the action is for: the responsible principal, as a reference (never a credential). Null when none was stated. */
  principal: string | null;
  /** The project, and the third-party account the action is scoped to, when it has one. */
  scope: { projectId: string; accountRef: string | null };
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
    | 'RELEASE_ENVELOPE'
    | 'OWNER_APPROVED'
    | 'NO_ACCOUNT_SCOPE'
    | 'ACCOUNT_OUT_OF_SCOPE'
    | 'ACTION_TYPE_NOT_APPROVED'
    | 'RATE_LIMITED'
    | 'SECRET_NOT_IN_STORE';
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
  obligations: { heldCents: number; heldCommitmentIds?: string[] } | null;
  remainingSafeWork: ConsequenceClass[];
  /** The stored request for `neededApproval`, or the approval that allowed this call (cash_needs row). */
  approvalNeedId?: string | null;
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
  /**
   * Overwritten by `decideAction` from the project's stop control rows
   * (`setEmergencyStop`). Only the pure `judgeAction` reads it, for tests; no
   * action path supplies it, so a caller cannot clear a stop by omitting it.
   */
  emergencyStop?: boolean;
  /** A fact read from the release grant's envelope, for engineering actions. */
  releaseEnvelopeAllows?: boolean;
  /** The responsible principal, read from the authenticated request — never from the action's payload. */
  principal?: string | null;
  /**
   * For a third-party authenticated action: the authorized account's own
   * limits, read from its record by the caller. Absent means no scope is
   * established, and the action is refused (deny by default).
   */
  account?: ThirdPartyAccountScope | null;
  at?: string;
}

/** One authorized third-party account's scope, as its record states it. */
export interface ThirdPartyAccountScope {
  /** A reference to the account, never its login or secret. */
  ref: string;
  /** The account is connected to this project and its owner's consent is on record. */
  inScope: boolean;
  /** The action types previously approved for this account. An action not listed is not approved. */
  approvedActionTypes: readonly string[];
  /** The site's rate limit and what has been used in the current window; both known, or the limit is treated as spent. */
  rateLimit?: { used: number; max: number } | null;
  /** The credential is held as a reference into the secrets store. False means it would travel inline (a prompt, an output, source). */
  credentialFromSecretsStore: boolean;
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
        principal: input.principal?.trim() ? input.principal.trim().slice(0, 120) : null,
        scope: { projectId: input.projectId, accountRef: input.account?.ref ?? null },
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

  if (klass === 'THIRD_PARTY_AUTHENTICATED') return judgeThirdParty(input, finish, ask);

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
 * A third-party authenticated action is judged inside the account's own scope:
 * the account must be connected and consented, the action type must have been
 * approved for it, its rate limit must have room, and its credential must come
 * from the secrets store. Each refusal says which, so the smallest missing
 * approval is the one thing that changes it. The account's facts are supplied
 * from its record; when they are not, nothing is assumed.
 */
function judgeThirdParty(
  input: JudgeInput,
  finish: (ok: boolean, cause: AuthorityLedgerRecord['cause'], reason: string, needs?: ActionDecision['neededApproval']) => ActionDecision,
  ask: (description: string) => NonNullable<ActionDecision['neededApproval']>,
): ActionDecision {
  const account = input.account;
  if (!account) {
    return finish(false, 'NO_ACCOUNT_SCOPE', 'no authorized account scope is established for this action', ask(`an authorized account, with its scope, for ${input.action}`));
  }
  if (!account.inScope) {
    return finish(false, 'ACCOUNT_OUT_OF_SCOPE', 'the account is not connected to this project with its owner\'s consent', ask(`the account owner's consent to connect this account to the project`));
  }
  if (!account.credentialFromSecretsStore) {
    return finish(false, 'SECRET_NOT_IN_STORE', 'the credential is not held in the secrets store, and a secret may not travel inline');
  }
  if (!account.approvedActionTypes.includes(input.action)) {
    return finish(false, 'ACTION_TYPE_NOT_APPROVED', `${input.action} is not an action type approved for this account`, ask(`approval of ${input.action} for this account`));
  }
  const limit = account.rateLimit;
  if (limit && (!Number.isFinite(limit.used) || !Number.isFinite(limit.max) || limit.used >= limit.max)) {
    return finish(false, 'RATE_LIMITED', 'the site\'s rate limit has no room left in this window');
  }
  return finish(true, 'ALLOWED', 'within the account\'s own scope, approved action types and rate limit');
}

/*
 * Asking for the smallest missing approval, and remembering the answer.
 *
 * `neededApproval` used to be text the caller was handed and nothing kept. The
 * existing owner of "something only a person can supply" is the needs register
 * (`cash_needs`), so a refusal that names an approval raises one need, keyed by
 * the scope it asks for, and an owner's answer settles that same row. No new
 * store: the ask, the answer, who gave it and when are all on that row and on
 * its `project_events` history.
 *
 *   - the same scope asked twice is one open need, not one per call;
 *   - RESOLVED by a person is an approval, and a later call for the same scope
 *     is allowed on it without asking again;
 *   - WITHDRAWN is a "no": it is remembered, and the same scope is not re-asked;
 *   - an approval that named an amount covers amounts up to it, and a larger one
 *     is a different scope, asked once more at a new occurrence.
 *
 * Only the causes a person's answer can address are honoured. A prohibition, an
 * emergency stop, a read-only grant's own limits and a lapsed or revoked grant
 * are never turned into a pass by an old answer: renewal is a grant row.
 */
const APPROVABLE_CAUSES: ReadonlyArray<AuthorityLedgerRecord['cause']> = [
  'NOT_COVERED',
  'NO_AUTHORITY',
  'ACTION_TYPE_NOT_APPROVED',
  'RELEASE_ENVELOPE',
  'OVER_PER_ACTION_CEILING',
  'OVER_COMMITTED_CEILING',
];

/** The scope an approval covers: one project, one action, one kind of shortfall. */
export function approvalScopeKey(projectId: string, action: string, cause: AuthorityLedgerRecord['cause']): string {
  return `authority-approval:${projectId}:${action}:${cause}`;
}

function approvalCovers(need: CashNeed, amountCents: number | null): boolean {
  return need.expectedCostCents === null || (amountCents !== null && amountCents <= need.expectedCostCents);
}

/** Record an owner's answer to a stored approval request. `approve: false` is remembered as a refusal. */
export async function answerApprovalRequest(input: {
  needId: string;
  approve: boolean;
  actorUserId: string;
  note: string;
}) {
  return closeNeed({
    needId: input.needId,
    to: input.approve ? 'RESOLVED' : 'WITHDRAWN',
    resolution: input.note,
    actorUserId: input.actorUserId,
  });
}

async function applyStoredApproval(input: JudgeInput, decision: ActionDecision): Promise<ActionDecision> {
  const needed = decision.neededApproval;
  const cause = decision.ledger.cause;
  if (decision.ok || !needed || !APPROVABLE_CAUSES.includes(cause)) return decision;
  const key = approvalScopeKey(input.projectId, input.action, cause);
  const amount = decision.ledger.amountCents;

  const latest = await needForKey(input.projectId, key);
  if (latest?.state === 'RESOLVED' && latest.resolvedByUserId && approvalCovers(latest, amount)) {
    return {
      ...decision,
      ok: true,
      reason: 'within an approval the owner already gave for this scope',
      neededApproval: null,
      obligations: null,
      remainingSafeWork: [],
      approvalNeedId: latest.id,
      ledger: { ...decision.ledger, disposition: 'PERFORMED', cause: 'OWNER_APPROVED' },
    };
  }
  if (latest?.state === 'WITHDRAWN' && approvalCovers(latest, amount)) {
    return {
      ...decision,
      reason: `${decision.reason}; the owner declined this approval, so it is not asked again`,
      neededApproval: null,
      approvalNeedId: latest.id,
    };
  }
  const open = await openNeedForKey(input.projectId, key);
  if (open) return { ...decision, approvalNeedId: open.id };
  const raised = await raiseNeed({
    projectId: input.projectId,
    actorRef: 'BRAIN',
    blockedAction: input.action,
    whyItMatters: decision.reason,
    recommendedPath: needed.description,
    expectedCostCents: amount,
    setupEffort: 'One approval from the owner; all other work continues meanwhile.',
    nextStep: `Approve or decline: ${needed.description}`,
    completionCondition: `The owner has answered the request for ${needed.description}.`,
    requestKey: key,
  });
  return { ...decision, approvalNeedId: raised.ok ? raised.value.id : null };
}

/*
 * The emergency stop is a row, and the action path reads it.
 *
 * It is event-sourced on `cash_events` (append-only, already the project's
 * cash history), so a stop and a resume are both on the record and neither
 * rewrites the other. The newest of the two wins, and a tie reads as stopped:
 * an ambiguity about whether risky mutations are paused resolves to paused.
 * Stopping pauses consequential effects only — internal work, held commitments
 * and their accounting carry on (see `remainingSafeWork`).
 */
export const EMERGENCY_STOP_KIND = 'AUTHORITY_EMERGENCY_STOP';
export const EMERGENCY_RESUME_KIND = 'AUTHORITY_EMERGENCY_RESUME';

/** Owner's stop control. Records who and why; changes no commitment, grant or ledger figure. */
export async function setEmergencyStop(input: {
  projectId: string;
  on: boolean;
  actorUserId: string;
  reason: string;
}) {
  return recordCashEvent({
    projectId: input.projectId,
    kind: input.on ? EMERGENCY_STOP_KIND : EMERGENCY_RESUME_KIND,
    actorRef: input.actorUserId,
    summary: input.reason.trim() || (input.on ? 'emergency stop on' : 'emergency stop lifted'),
  });
}

/** Whether the project's newest stop-control row says risky mutations are paused. */
export async function emergencyStopOn(projectId: string): Promise<boolean> {
  const stops = await cashEventsOfKindInProject(projectId, EMERGENCY_STOP_KIND);
  const last = stops[stops.length - 1];
  if (!last) return false;
  const resumes = await cashEventsOfKindInProject(projectId, EMERGENCY_RESUME_KIND);
  const resumed = resumes[resumes.length - 1];
  return !resumed || resumed.createdAt <= last.createdAt;
}

/** Revoked: nothing is in force and the newest grant ended by revocation, not by a later grant or by time. */
function wasRevoked(all: readonly CashAuthority[]): boolean {
  const newest = all[0];
  return !!newest && newest.state === 'REVOKED';
}

/**
 * Record what a stop or revocation left behind: the commitments still owed, the
 * work that may continue, and the one authorization that would resume the
 * refused action. Append-only and deduplicated, so a retry loop adds one row.
 */
async function recordSuspension(input: JudgeInput, decision: ActionDecision, heldIds: string[]): Promise<void> {
  const cause = decision.ledger.cause;
  if (cause !== 'REVOKED' && cause !== 'EMERGENCY_STOP') return;
  const kind = 'AUTHORITY_ACTION_SUSPENDED';
  const detail = {
    action: input.action,
    cause,
    path: decision.ledger.path,
    heldCents: decision.obligations?.heldCents ?? 0,
    heldCommitmentIds: heldIds,
    remainingSafeWork: decision.remainingSafeWork,
    needsAuthorization:
      decision.neededApproval?.description ?? `lift the emergency stop to allow ${input.action}`,
  };
  const earlier = await cashEventsOfKindInProject(input.projectId, kind);
  const last = earlier[earlier.length - 1];
  const same = last && JSON.stringify(last.detail) === JSON.stringify(detail);
  if (same) return;
  await recordCashEvent({
    projectId: input.projectId,
    kind,
    actorRef: 'BRAIN',
    summary: `${input.action} was refused (${cause}); obligations stay tracked and safe work continues.`,
    detail,
  });
}

/**
 * Judge an action against the live rows. This is the one call every action path
 * — an API, a browser automation, a worker — makes before an effect.
 */
export async function decideAction(input: JudgeInput): Promise<ActionDecision> {
  const decision = await judgeLive(input);
  await recordDecision(decision);
  return decision;
}

export const AUTHORITY_DECISION_KIND = 'AUTHORITY_DECISION';

/**
 * Append the decision's ledger record to `cash_events`, the project's append-only history, so what
 * Brain performed, proposed or was refused is inspectable later and not only returned to a caller.
 * Every consequential decision leaves a row, allowed or refused, one per attempt; routine internal
 * actions leave none (a presentation choice: they are reversible and inside authorized scope).
 * The row carries references and machine causes only — never a credential or a caller's free text.
 * If the row cannot be written the error propagates, so no effect follows an unrecorded decision.
 */
async function recordDecision(decision: ActionDecision): Promise<void> {
  const l = decision.ledger;
  if (decision.consequenceClass === null || decision.consequenceClass === 'INTERNAL') return;
  await recordCashEvent({
    projectId: l.projectId,
    kind: AUTHORITY_DECISION_KIND,
    actorRef: 'BRAIN',
    summary: `${l.action}: ${l.disposition} (${l.cause})`,
    detail: {
      action: l.action,
      consequenceClass: l.consequenceClass,
      path: l.path,
      principal: l.principal,
      scope: l.scope,
      disposition: l.disposition,
      cause: l.cause,
      policyVersion: l.policyVersion,
      amountCents: l.amountCents,
      decidedAt: l.at,
      ok: decision.ok,
      approvalNeedId: decision.approvalNeedId ?? null,
      neededApproval: decision.neededApproval?.description ?? null,
    },
  });
}

async function judgeLive(input: JudgeInput): Promise<ActionDecision> {
  const klass = classifyAction(input.action);
  if (klass === 'INTERNAL' || !klass) return judgeAction({ ...input, emergencyStop: false }, { authority: null, revoked: false, heldCents: 0 });
  const stopped = await emergencyStopOn(input.projectId);
  const authority = await liveAuthority(input.projectId, input.at);
  let revoked = false;
  if (!authority) revoked = wasRevoked(await listAuthorities(input.projectId));
  const held = await heldCentsForProject(input.projectId, authority?.currency);
  const decision = await applyStoredApproval(
    input,
    judgeAction({ ...input, emergencyStop: stopped }, { authority, revoked, heldCents: held }),
  );
  const cause = decision.ledger.cause;
  if (cause !== 'REVOKED' && cause !== 'EMERGENCY_STOP') return decision;
  const heldIds = (await listCommitments(input.projectId)).filter((one) => one.state === 'HELD').map((one) => one.id);
  const out: ActionDecision = {
    ...decision,
    obligations: { heldCents: held, heldCommitmentIds: heldIds },
  };
  await recordSuspension(input, out, heldIds);
  return out;
}
