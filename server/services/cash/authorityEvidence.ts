/**
 * Whether graduated authority (AUTH-20-3), read-only learning (AUTH-21-6) and
 * policy-to-action authority (AUTH-34) actually hold in this Brain: read from
 * the decision ledger and the stop, suspension, grant and approval rows the
 * action path already writes.
 *
 * Read-only. Nothing here writes a row, creates a grant or answers a need.
 *
 * These are the bodies the protected probes `r01.auth-20-3`, `r01.auth-21-6`
 * and `r01.auth-34` call. The registrations themselves belong under the
 * protected verification path (`server/services/factory/program/**`, §96), which
 * no implementing campaign may write, so the check it is judged by is not
 * authored by the change it judges. Each function answers `{ ok, detail }`, the
 * probe result shape, and deny by default: no rows is "not demonstrated",
 * never a pass (§47 — a real row is not an answer to a question it never
 * answered).
 *
 * Each requirement is checked in two parts, and both must hold:
 *
 *   - **the rule**: the pure judgment `judgeAction` is run over a fixed set of
 *     scenarios in memory (no rows touched), so a regression in the code that
 *     would make the clause false fails even before production shows it;
 *   - **the record**: production rows show the clause was exercised — the
 *     ledger exists, every row is complete, no consequential effect is recorded
 *     as performed while a stop, a revocation or a refusal cause was in force,
 *     and no credential appears in any of it.
 */
import { getDb } from '../../db/database.ts';
import { listAuthorities } from '../../repos/cashAuthority.ts';
import {
  isLedgered,
  ALWAYS_PROHIBITED_COMMERCIAL,
  AUTHORITY_DECISION_KIND,
  AUTHORITY_EFFECT_KIND,
  COMMERCIAL_ACTIONS,
  CONSEQUENCE_CLASSES,
  EMERGENCY_RESUME_KIND,
  EMERGENCY_STOP_KIND,
  approvalScopeKey,
  classifyAction,
  judgeAction,
  type ActionDecision,
  type JudgeInput,
  type JudgeState,
} from './authority.ts';
import type { CashAuthority } from '../../domain/types.ts';

export interface AuthorityEvidence {
  ok: boolean;
  detail: string;
}

export const AUTHORITY_SUSPENDED_KIND = 'AUTHORITY_ACTION_SUSPENDED';

/* ------------------------------------------------------------------------- */
/* The rule: pure scenarios                                                    */
/* ------------------------------------------------------------------------- */

const SCENARIO_PROJECT = 'prj_scenario';
const SCENARIO_AT = '2026-06-01T00:00:00.000Z';

/** A full grant covering every commercial action, as a person would write it. */
function scenarioGrant(overrides: Partial<CashAuthority> = {}): CashAuthority {
  return {
    id: 'cau_scenario',
    projectId: SCENARIO_PROJECT,
    ownerUserId: 'usr_owner',
    createdByUserId: 'usr_owner',
    name: 'scenario grant',
    allowedActions: [...COMMERCIAL_ACTIONS],
    prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
    maxCommittedCents: 100_000,
    maxPerActionCents: 40_000,
    maxConcurrent: 3,
    currency: 'USD',
    policyVersion: 1,
    startsAt: '2026-01-01T00:00:00.000Z',
    expiresAt: null,
    state: 'ACTIVE',
    revokedAt: null,
    revokedByUserId: null,
    revokedReason: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const live = (authority: CashAuthority | null = scenarioGrant()): JudgeState => ({ authority, revoked: false, heldCents: 0 });
const judge = (input: Partial<JudgeInput> & { action: string }, state: JudgeState = live()): ActionDecision =>
  judgeAction({ projectId: SCENARIO_PROJECT, at: SCENARIO_AT, principal: 'usr_owner', ...input }, state);

/** Representative actions of each class: one name per class is enough to catch a lost mapping. */
const CLASS_EXAMPLES: Record<(typeof CONSEQUENCE_CLASSES)[number], string[]> = {
  INTERNAL: ['READ_PUBLIC_SOURCE', 'READ_ONLY_ANALYSIS', 'PARSE', 'NON_PRODUCTION_EXPERIMENT', 'CALCULATE', 'DEDUPLICATE', 'DESIGN_METHOD', 'GENERATE_BENCHMARK', 'REVERSIBLE_STATE_CHANGE', 'LEARN_FROM_SITE', 'VIEW_PORTAL', 'DRAFT_MESSAGE'],
  STANDING_GRANT_ENGINEERING: ['FACTORY_CODE', 'FACTORY_TEST', 'FACTORY_MERGE', 'FACTORY_DEPLOY'],
  THIRD_PARTY_AUTHENTICATED: ['AUTHENTICATED_READ', 'AUTHENTICATED_OPERATION'],
  EXTERNALLY_CONSEQUENTIAL: ['SEND_OUTREACH', 'SIGN_AGREEMENT', 'INITIATE_PAYMENT', 'MOVE_FUNDS', 'CREATE_ACCOUNT', 'PUBLISH_EXTERNALLY', 'SUBMIT_BID', 'GRANT_ACCESS', 'CHANGE_WEBSITE'],
};

/** The agency a read-only learning mechanism must never reach (S-0303). */
export const READ_ONLY_NEVER_AUTHORIZES = ['SIGN_AGREEMENT', 'SEND_OUTREACH', 'SUBMIT_BID', 'INITIATE_PAYMENT', 'SCRAPE_PROTECTED', 'CREATE_ACCOUNT', 'SUBMIT_FORM', 'MOVE_FUNDS'] as const;

type Failure = string | null;

function first(checks: Array<() => Failure>): Failure {
  for (const check of checks) {
    const failure = check();
    if (failure) return failure;
  }
  return null;
}

/** AUTH-20-3's rule: four classes, internal work free, consequential work on existing authority, the smallest ask named. */
export function graduatedAuthorityRule(): Failure {
  return first([
    () => {
      for (const klass of CONSEQUENCE_CLASSES) {
        for (const action of CLASS_EXAMPLES[klass]) {
          if (classifyAction(action) !== klass) return `${action} classifies as ${classifyAction(action)}, not ${klass}`;
        }
      }
      return classifyAction('SOMETHING_NEW') === null ? null : 'an unknown action was given a class';
    },
    () => {
      // Internal work needs no grant at all, and survives a stop or revocation.
      const none = judge({ action: 'READ_PUBLIC_SOURCE' }, { authority: null, revoked: true, heldCents: 0 });
      const stopped = judge({ action: 'GENERATE_BENCHMARK', emergencyStop: true }, live(null));
      return none.ok && stopped.ok ? null : 'internal work was refused for want of a grant';
    },
    () => {
      // Engineering is allowed only inside the release envelope.
      const inside = judge({ action: 'FACTORY_MERGE', releaseEnvelopeAllows: true });
      const outside = judge({ action: 'FACTORY_DEPLOY' });
      if (!inside.ok) return 'an engineering action inside the release envelope was refused';
      if (outside.ok || outside.ledger.cause !== 'RELEASE_ENVELOPE') return 'an engineering action outside the release envelope was allowed';
      return outside.neededApproval ? null : 'a release-envelope refusal named no approval';
    },
    () => {
      // A third-party operation is held to the account's own scope, and a secret never travels inline.
      const account = { ref: 'acct_x', inScope: true, approvedActionTypes: ['AUTHENTICATED_READ'], credentialFromSecretsStore: true, rateLimit: { used: 0, max: 10 } };
      if (!judge({ action: 'AUTHENTICATED_READ', account }).ok) return 'an approved action type inside the account scope was refused';
      if (judge({ action: 'AUTHENTICATED_OPERATION', account }).ledger.cause !== 'ACTION_TYPE_NOT_APPROVED') return 'an unapproved action type was not refused as such';
      if (judge({ action: 'AUTHENTICATED_READ', account: { ...account, credentialFromSecretsStore: false } }).ledger.cause !== 'SECRET_NOT_IN_STORE') return 'an inline credential was not refused';
      if (judge({ action: 'AUTHENTICATED_READ', account: { ...account, rateLimit: { used: 10, max: 10 } } }).ok) return 'a spent rate limit was ignored';
      return judge({ action: 'AUTHENTICATED_READ' }).ok ? 'an action with no account scope was allowed' : null;
    },
    () => {
      // Consequential acts need the existing grant: none → refused, and the smallest grant is named.
      const refused = judge({ action: 'QUOTE_AND_INVOICE' }, live(null));
      if (refused.ok || refused.ledger.cause !== 'NO_AUTHORITY') return 'a consequential act with no grant was not refused';
      if (!refused.neededApproval?.description.includes('QUOTE_AND_INVOICE')) return 'the refusal did not name the one grant that would change it';
      const over = judge({ action: 'PURCHASE_TOOL_OR_DATA', amountCents: 50_000 });
      if (over.ok || !over.neededApproval?.description.includes('50000')) return 'an over-ceiling spend did not name the smallest ceiling that would allow it';
      return approvalScopeKey('p', 'A', 'NOT_COVERED') === approvalScopeKey('p', 'A', 'NOT_COVERED') ? null : 'the approval scope key is not stable';
    },
    () => {
      // Brain never grants itself authority: the unconditionally prohibited acts stay refused under a grant that lists them.
      const greedy = scenarioGrant({ allowedActions: [...COMMERCIAL_ACTIONS, ...ALWAYS_PROHIBITED_COMMERCIAL], prohibitions: [] });
      for (const action of ALWAYS_PROHIBITED_COMMERCIAL) {
        if (judge({ action }, live(greedy)).ok) return `${action} was allowed`;
      }
      return null;
    },
  ]);
}

/** AUTH-21-6's rule: read-only access never reaches consequential agency, on any path; research continues. */
export function readOnlyLearningRule(): Failure {
  return first([
    () => {
      for (const action of READ_ONLY_NEVER_AUTHORIZES) {
        for (const path of ['BROWSER', 'API'] as const) {
          const decision = judge({ action, access: 'READ_ONLY', path, amountCents: 100 });
          if (decision.ok) return `read-only access authorized ${action} through ${path}`;
        }
      }
      return null;
    },
    () => {
      // Learning from a site, viewing a portal, reading public sources: allowed even with no grant and a payment need open.
      for (const action of ['LEARN_FROM_SITE', 'VIEW_PORTAL', 'READ_PUBLIC_SOURCE']) {
        if (!judge({ action, access: 'READ_ONLY', path: 'BROWSER' }, live(null)).ok) return `${action} was refused to a read-only learner`;
      }
      return null;
    },
    () => {
      const payment = judge({ action: 'INITIATE_PAYMENT', access: 'READ_ONLY', path: 'BROWSER', amountCents: 100 });
      if (payment.ledger.cause !== 'READ_ONLY_GRANT') return 'a read-only payment attempt was not refused as read-only';
      return payment.neededApproval ? null : 'the read-only refusal did not name the separate authority it needs';
    },
  ]);
}

/** AUTH-34's rule: the acceptance demonstration, in memory. */
export function policyToActionRule(): Failure {
  return first([
    () => {
      // A portfolio: research, software improvement and a permissible commercial act proceed together...
      const portfolio = [
        judge({ action: 'READ_PUBLIC_SOURCE' }),
        judge({ action: 'FACTORY_CODE', releaseEnvelopeAllows: true }),
        judge({ action: 'QUOTE_AND_INVOICE', path: 'API' }),
      ];
      if (portfolio.some((d) => !d.ok)) return 'concurrent approved work was refused';
      // ...while a prohibited spend, an unsolicited send and a contract submission are blocked.
      const tight = scenarioGrant({ allowedActions: ['QUOTE_AND_INVOICE'] });
      const blocked = [
        judge({ action: 'PURCHASE_TOOL_OR_DATA', amountCents: 1_000 }, live(tight)),
        judge({ action: 'SEND_OUTREACH', path: 'BROWSER' }, live(tight)),
        judge({ action: 'SIGN_AGREEMENT', path: 'BROWSER' }, live(tight)),
        judge({ action: 'SUBMIT_FORM', path: 'BROWSER', access: 'READ_ONLY' }, live(tight)),
      ];
      return blocked.every((d) => !d.ok && d.ledger.disposition === 'REFUSED') ? null : 'a prohibited spend, send or contract was allowed';
    },
    () => {
      // Mid-flight revocation stops further external mutations, keeps obligations and names the renewal.
      const revoked = judge({ action: 'QUOTE_AND_INVOICE', path: 'API' }, { authority: null, revoked: true, heldCents: 2_500 });
      if (revoked.ok || revoked.ledger.cause !== 'REVOKED') return 'a revoked grant still authorized a mutation';
      if (revoked.obligations?.heldCents !== 2_500) return 'revocation lost track of the obligations already held';
      if (!revoked.remainingSafeWork.includes('INTERNAL')) return 'revocation did not name the safe work that continues';
      if (!revoked.neededApproval?.description.includes('QUOTE_AND_INVOICE')) return 'revocation did not name the precise action needing renewal';
      return judge({ action: 'READ_ONLY_ANALYSIS' }, { authority: null, revoked: true, heldCents: 2_500 }).ok ? null : 'revocation stopped safe work';
    },
    () => {
      // The emergency stop pauses risky mutations and nothing else.
      const stopped = judge({ action: 'QUOTE_AND_INVOICE', emergencyStop: true });
      if (stopped.ok || stopped.ledger.cause !== 'EMERGENCY_STOP') return 'the emergency stop did not pause a mutation';
      return judge({ action: 'CALCULATE', emergencyStop: true }).ok ? null : 'the emergency stop paused safe work';
    },
    () => {
      // Expiry, and the ledger distinguishes performed from proposed; principal and scope are recorded.
      const expired = judge({ action: 'QUOTE_AND_INVOICE' }, live(scenarioGrant({ expiresAt: '2026-02-01T00:00:00.000Z' })));
      if (expired.ok || expired.ledger.cause !== 'EXPIRED_OR_NOT_STARTED') return 'an expired grant authorized a mutation';
      const proposed = judge({ action: 'SEND_OUTREACH', mode: 'PROPOSE' }, live(null));
      if (!proposed.ok || proposed.ledger.disposition !== 'PROPOSED') return 'a proposal was not recorded as proposed';
      if (!isLedgered(proposed)) return 'a proposal would leave no ledger row';
      const draft = judge({ action: 'DRAFT_MESSAGE' });
      if (draft.ledger.disposition !== 'PROPOSED' || !isLedgered(draft)) return 'a drafted message was not recorded as a proposal';
      if (isLedgered(judge({ action: 'CALCULATE' }))) return 'routine internal work was ledgered as if it were a proposal';
      // An allowed action is authorized, not performed: the decision precedes the effect, which can still fail,
      // come back unknown or be a replay, so "performed" is only ever the effect's own receipt.
      const allowed = judge({ action: 'QUOTE_AND_INVOICE' });
      if (allowed.ledger.disposition !== 'AUTHORIZED') return 'an allowed action was recorded as performed before any effect was attempted';
      if (allowed.ledger.principal !== 'usr_owner' || allowed.ledger.scope.projectId !== SCENARIO_PROJECT) return 'the ledger lost the principal or the scope';
      return null;
    },
  ]);
}

/* ------------------------------------------------------------------------- */
/* The record: production rows                                                 */
/* ------------------------------------------------------------------------- */

interface EventRow {
  id: string;
  project_id: string;
  kind: string;
  detail: string | null;
  created_at: string;
}

interface Decision {
  id: string;
  projectId: string;
  /** When the judgment was made (the ledger's own `decidedAt`), else when the row was written. */
  at: string;
  detail: Record<string, unknown>;
}

/**
 * A decision's disposition. PERFORMED is accepted only as history: rows written
 * before a decision and its effect were told apart labelled an authorization
 * PERFORMED, and they are read as what they were — an authorization.
 */
const DISPOSITIONS = new Set(['AUTHORIZED', 'PROPOSED', 'REFUSED', 'PERFORMED']);

/** A decision that let the action go ahead (an authorization, including the legacy PERFORMED label). */
function granted(d: Decision): boolean {
  return d.detail.disposition === 'AUTHORIZED' || d.detail.disposition === 'PERFORMED';
}
const PATHS = new Set(['API', 'BROWSER', 'INTERNAL']);
const NON_INTERNAL = new Set<string>(CONSEQUENCE_CLASSES.filter((k) => k !== 'INTERNAL'));
/** Shapes a credential takes. A row matching one is a leak, whatever field it is in. */
const CREDENTIAL_SHAPES = [/sk-[A-Za-z0-9_-]{16,}/, /gh[pousr]_[A-Za-z0-9]{20,}/, /Bearer\s+[A-Za-z0-9._-]{16,}/i, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /"(password|secret|api_?key|token)"\s*:\s*"[^"]+"/i];

function parse(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function rowsOfKinds(kinds: string[]): Promise<EventRow[]> {
  const marks = kinds.map(() => '?').join(', ');
  return getDb().all<EventRow>(
    `SELECT id, project_id, kind, detail, created_at FROM cash_events WHERE kind IN (${marks}) ORDER BY created_at, id`,
    kinds,
  );
}

async function decisions(): Promise<Decision[]> {
  const rows = await rowsOfKinds([AUTHORITY_DECISION_KIND]);
  return rows.map((r) => {
    const detail = parse(r.detail);
    const decidedAt = typeof detail.decidedAt === 'string' && detail.decidedAt ? detail.decidedAt : r.created_at;
    return { id: r.id, projectId: r.project_id, at: decidedAt, detail };
  });
}

/** A ledger row is complete when it answers what, how, for whom, where, with what result and why. */
function incomplete(d: Decision): Failure {
  const x = d.detail;
  if (typeof x.action !== 'string' || !x.action) return `decision ${d.id} names no action`;
  // A proposal of internal work (a drafted message) is ledgered too: what Brain proposed is half the record.
  const classOk =
    typeof x.consequenceClass === 'string' &&
    (NON_INTERNAL.has(x.consequenceClass) || (x.consequenceClass === 'INTERNAL' && x.disposition === 'PROPOSED'));
  if (!classOk) return `decision ${d.id} has no consequential class`;
  if (typeof x.path !== 'string' || !PATHS.has(x.path)) return `decision ${d.id} names no path`;
  if (typeof x.disposition !== 'string' || !DISPOSITIONS.has(x.disposition)) return `decision ${d.id} does not say whether it was performed or proposed`;
  if (typeof x.cause !== 'string' || !x.cause) return `decision ${d.id} records no cause`;
  if (!('principal' in x)) return `decision ${d.id} records no principal field`;
  const scope = x.scope as { projectId?: unknown } | undefined;
  if (!scope || scope.projectId !== d.projectId) return `decision ${d.id} records no scope for its own project`;
  if (!('policyVersion' in x) || !('amountCents' in x)) return `decision ${d.id} omits the grant version or the amount`;
  if ((x.disposition === 'AUTHORIZED' || x.disposition === 'PERFORMED') && x.ok !== true) return `decision ${d.id} is recorded as authorized and refused at once`;
  if (x.disposition === 'REFUSED' && x.ok !== false) return `decision ${d.id} is recorded as refused and allowed at once`;
  return null;
}

function leaks(rows: Array<{ id: string; detail: Record<string, unknown> }>): Failure {
  for (const row of rows) {
    const text = JSON.stringify(row.detail);
    if (CREDENTIAL_SHAPES.some((shape) => shape.test(text))) return `row ${row.id} carries something shaped like a credential`;
  }
  return null;
}

/** Was the project's emergency stop on at `at`? Newest of stop/resume at or before it wins; a tie reads as stopped. */
function stoppedAt(controls: EventRow[], projectId: string, at: string): boolean {
  let lastStop: string | null = null;
  let lastResume: string | null = null;
  for (const c of controls) {
    if (c.project_id !== projectId || c.created_at > at) continue;
    if (c.kind === EMERGENCY_STOP_KIND) lastStop = c.created_at;
    else lastResume = c.created_at;
  }
  return lastStop !== null && (lastResume === null || lastResume <= lastStop);
}

/**
 * Was some grant of the project in force at `at` (started, not expired, not yet revoked)?
 *
 * A revocation stamped in the same instant as the judgment is not "before" it:
 * the judgment read the grant as ACTIVE, so the revocation committed after
 * that read. Timestamps are millisecond strings and such a tie is ordinary.
 */
function grantInForce(grants: readonly CashAuthority[], at: string): boolean {
  return grants.some((g) => g.startsAt <= at && (g.expiresAt === null || g.expiresAt > at) && (g.revokedAt === null || g.revokedAt >= at));
}

async function ledgerSummary(): Promise<{ failure: Failure; all: Decision[] }> {
  const all = await decisions();
  if (all.length === 0) return { failure: 'no authority decision is recorded on this Brain yet', all };
  const failure = first([...all.map((d) => () => incomplete(d)), () => leaks(all)]);
  return { failure, all };
}

/**
 * AUTH-20-3 on production: the ledger exists and is complete; the consequential
 * classes are all represented by real decisions; a refusal that named an
 * approval raised (and so remembers) a stored request; no row leaks a secret.
 */
export async function graduatedAuthorityEvidence(): Promise<AuthorityEvidence> {
  const rule = graduatedAuthorityRule();
  if (rule) return { ok: false, detail: `the rule does not hold: ${rule}` };
  const { failure, all } = await ledgerSummary();
  if (failure) return { ok: false, detail: failure };
  const asked = all.filter((d) => d.detail.ok === false && typeof d.detail.neededApproval === 'string');
  const unstored = asked.find((d) => typeof d.detail.approvalNeedId !== 'string' || !d.detail.approvalNeedId);
  if (unstored) return { ok: false, detail: `decision ${unstored.id} named an approval without storing the request` };
  if (asked.length > 0) {
    const ids = [...new Set(asked.map((d) => String(d.detail.approvalNeedId)))];
    const marks = ids.map(() => '?').join(', ');
    const needs = await getDb().all<{ id: string; request_key: string | null }>(`SELECT id, request_key FROM cash_needs WHERE id IN (${marks})`, ids);
    const keyed = new Set(needs.filter((n) => n.request_key?.startsWith('authority-approval:')).map((n) => n.id));
    const missing = ids.find((id) => !keyed.has(id));
    if (missing) return { ok: false, detail: `approval request ${missing} is not a stored, scope-keyed need` };
  }
  const classes = new Set(all.map((d) => String(d.detail.consequenceClass)));
  const authorized = all.filter(granted).length;
  const refused = all.filter((d) => d.detail.disposition === 'REFUSED').length;
  const { failure: effectFailure, effects } = await effectSummary(all);
  if (effectFailure) return { ok: false, detail: effectFailure };
  const performed = effects.filter((e) => e.detail.disposition === 'PERFORMED').length;
  return {
    ok: true,
    detail: `${all.length} ledger decision(s) across ${new Set(all.map((d) => d.projectId)).size} project(s) (${authorized} authorized, ${refused} refused; classes ${[...classes].sort().join(', ')}); ${effects.length} effect receipt(s), ${performed} performed; ${asked.length} smallest-approval request(s) stored`,
  };
}

const EFFECT_DISPOSITIONS = new Set(['PERFORMED', 'REPLAYED', 'FAILED', 'UNKNOWN']);

/**
 * The effect receipts: what Brain actually did, each beside the authorization it
 * followed. A receipt must say one of the four outcomes, and one that says
 * PERFORMED must name a decision on this ledger, for the same project and
 * action, that allowed it — a performed effect with no authorization, or after
 * a refusal, is exactly the contradiction the ledger exists to expose.
 */
async function effectSummary(all: readonly Decision[]): Promise<{ failure: Failure; effects: Array<{ id: string; projectId: string; at: string; detail: Record<string, unknown> }> }> {
  const effects = (await rowsOfKinds([AUTHORITY_EFFECT_KIND])).map((r) => ({ id: r.id, projectId: r.project_id, at: r.created_at, detail: parse(r.detail) }));
  const byId = new Map(all.map((d) => [d.id, d]));
  for (const e of effects) {
    const x = e.detail;
    if (typeof x.disposition !== 'string' || !EFFECT_DISPOSITIONS.has(x.disposition)) return { failure: `effect ${e.id} does not say what happened`, effects };
    if (x.disposition !== 'PERFORMED') continue;
    const decision = typeof x.decisionId === 'string' ? byId.get(x.decisionId) : undefined;
    if (!decision) return { failure: `effect ${e.id} was performed with no authorization decision on the ledger`, effects };
    if (!granted(decision) || decision.projectId !== e.projectId || decision.detail.action !== x.action) {
      return { failure: `effect ${e.id} was performed under decision ${decision.id}, which did not authorize it`, effects };
    }
  }
  const leak = leaks(effects);
  return { failure: leak, effects };
}

/** Actions Brain drafts before it performs them, so a performed one must have its proposal on the ledger. */
const PROPOSED_BEFORE_PERFORMED = new Set<string>(['CONTACT_BUYER']);

/** Refusal causes that may never sit beside a performed effect. */
const NEVER_PERFORMED_UNDER = new Set(['READ_ONLY_GRANT', 'PROHIBITED', 'EMERGENCY_STOP', 'REVOKED', 'UNKNOWN_ACTION', 'SECRET_NOT_IN_STORE']);

/**
 * AUTH-21-6 on production: no decision recorded a read-only holder performing a
 * consequential act, none of the agency S-0303 names was performed with no grant
 * in force, and every read-only refusal named the separate authority it needs.
 */
export async function readOnlyLearningEvidence(): Promise<AuthorityEvidence> {
  const rule = readOnlyLearningRule();
  if (rule) return { ok: false, detail: `the rule does not hold: ${rule}` };
  const { failure, all } = await ledgerSummary();
  if (failure) return { ok: false, detail: failure };
  const contradiction = all.find((d) => granted(d) && NEVER_PERFORMED_UNDER.has(String(d.detail.cause)));
  if (contradiction) return { ok: false, detail: `decision ${contradiction.id} performed ${String(contradiction.detail.action)} under ${String(contradiction.detail.cause)}` };
  const readOnly = all.filter((d) => d.detail.cause === 'READ_ONLY_GRANT');
  const silent = readOnly.find((d) => typeof d.detail.neededApproval !== 'string');
  if (silent) return { ok: false, detail: `read-only refusal ${silent.id} named no separate authority` };
  const agency = new Set<string>(READ_ONLY_NEVER_AUTHORIZES);
  const grants = new Map<string, CashAuthority[]>();
  for (const d of all) {
    if (!granted(d) || !agency.has(String(d.detail.action)) || d.detail.cause === 'OWNER_APPROVED') continue;
    if (!grants.has(d.projectId)) grants.set(d.projectId, await listAuthorities(d.projectId));
    if (!grantInForce(grants.get(d.projectId) ?? [], d.at)) return { ok: false, detail: `decision ${d.id} performed ${String(d.detail.action)} with no grant in force` };
  }
  return { ok: true, detail: `${all.length} ledger decision(s); ${readOnly.length} read-only refusal(s), each naming the separate authority; no consequential act performed on read-only access` };
}

/**
 * AUTH-34 on production: every decision records principal, scope, class, path,
 * grant version and disposition; no consequential effect was performed while
 * the project's emergency stop was on or with no grant in force (unless the
 * owner approved that scope); every suspension recorded the obligations still
 * owed, the safe work that continues and the precise action needing renewal.
 */
export async function policyToActionEvidence(): Promise<AuthorityEvidence> {
  const rule = policyToActionRule();
  if (rule) return { ok: false, detail: `the rule does not hold: ${rule}` };
  const { failure, all } = await ledgerSummary();
  if (failure) return { ok: false, detail: failure };
  const controls = await rowsOfKinds([EMERGENCY_STOP_KIND, EMERGENCY_RESUME_KIND]);
  const grants = new Map<string, CashAuthority[]>();
  for (const d of all) {
    if (!granted(d) || d.detail.consequenceClass !== 'EXTERNALLY_CONSEQUENTIAL') continue;
    if (stoppedAt(controls, d.projectId, d.at)) return { ok: false, detail: `decision ${d.id} performed ${String(d.detail.action)} while the emergency stop was on` };
    if (d.detail.cause === 'OWNER_APPROVED') continue;
    if (!grants.has(d.projectId)) grants.set(d.projectId, await listAuthorities(d.projectId));
    if (!grantInForce(grants.get(d.projectId) ?? [], d.at)) return { ok: false, detail: `decision ${d.id} performed ${String(d.detail.action)} with no grant in force` };
  }
  const suspensions = (await rowsOfKinds([AUTHORITY_SUSPENDED_KIND])).map((r) => ({ id: r.id, detail: parse(r.detail) }));
  for (const s of suspensions) {
    const x = s.detail;
    if (!Array.isArray(x.heldCommitmentIds) || typeof x.heldCents !== 'number') return { ok: false, detail: `suspension ${s.id} lost track of the obligations held` };
    if (!Array.isArray(x.remainingSafeWork) || x.remainingSafeWork.length === 0) return { ok: false, detail: `suspension ${s.id} names no safe work that continues` };
    if (typeof x.needsAuthorization !== 'string' || !x.needsAuthorization) return { ok: false, detail: `suspension ${s.id} names no action needing renewed authorization` };
  }
  const leak = leaks(suspensions);
  if (leak) return { ok: false, detail: leak };
  const { failure: effectFailure, effects } = await effectSummary(all);
  if (effectFailure) return { ok: false, detail: effectFailure };
  const browser = all.filter((d) => d.detail.path === 'BROWSER').length;
  const proposed = all.filter((d) => d.detail.disposition === 'PROPOSED').length;
  /*
   * What Brain proposed is the other half of what it did. A message Brain drafted itself is recorded as
   * PROPOSED before it is authorized or sent (`operate.ts`), so a buyer contact Brain performed with no
   * proposal of it on the ledger means the ledger shows what was done and not what was proposed.
   */
  const unproposed = effects.find(
    (e) =>
      e.detail.disposition === 'PERFORMED' &&
      PROPOSED_BEFORE_PERFORMED.has(String(e.detail.action)) &&
      !all.some((d) => d.projectId === e.projectId && d.detail.disposition === 'PROPOSED' && d.detail.action === e.detail.action),
  );
  if (unproposed) {
    return { ok: false, detail: `effect ${unproposed.id} performed ${String(unproposed.detail.action)} with no proposal of it on the ledger: what Brain proposed was never recorded` };
  }
  return {
    ok: true,
    detail: `${all.length} ledger decision(s) (${browser} on a browser path, ${proposed} proposed only), each with principal, scope, class and grant version; no consequential effect under a stop or outside a grant; ${effects.length} effect receipt(s) (${effects.filter((e) => e.detail.disposition === 'PERFORMED').length} performed), each naming the authorization it followed; ${suspensions.length} suspension(s), each keeping its obligations and naming the renewal`,
  };
}
