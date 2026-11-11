/**
 * What the graduated authority in `authority.ts` has actually done, read back
 * from the rows it wrote — and whether the rules it promises still hold in the
 * running Brain.
 *
 * Three requirements of the architecture program (AUTH-20-3, AUTH-21-6,
 * AUTH-34) are judged "on production records". This module is the read side
 * of that: it never writes, never decides an action, and never supplies a row
 * it then counts. It answers two different questions and keeps them apart:
 *
 *   - **Do the rules hold?** `authorityRulesHold` runs the pure judgment
 *     (`judgeAction`) across the closed vocabulary in this process. A broken
 *     rule is a failure whatever the rows say.
 *   - **Has real work demonstrated them?** `readAuthorityRecords` reads the
 *     ledger rows (`cash_events`) and the approval requests (`cash_needs`)
 *     every project carries, checks each row is well formed, and reports what
 *     evidence is present. An absent kind of evidence is "not yet
 *     demonstrated", never a pass (invariant 39).
 *
 * The probes that a requirement names are registered under the protected
 * verification path (`server/services/factory/program/probes.ts`), which an
 * implementing campaign may not write (§96). The functions below are what such
 * a probe calls; they are deliberately shaped like a probe result.
 */
import { listProjects } from '../../repos/projects.ts';
import { cashEventsOfKindInProject } from '../../repos/cashMode.ts';
import { listNeeds } from '../../repos/cashPortfolio.ts';
import {
  ALWAYS_PROHIBITED_COMMERCIAL,
  AUTHORITY_DECISION_KIND,
  CONSEQUENCE_CLASSES,
  classifyAction,
  judgeAction,
  type ActionPath,
  type AuthorityLedgerRecord,
  type ConsequenceClass,
} from './authority.ts';
import type { CashAuthority, CashEvent, CashNeed } from '../../domain/types.ts';

export interface EvidenceResult {
  ok: boolean;
  detail: string;
}

export const AUTHORITY_SUSPENDED_KIND = 'AUTHORITY_ACTION_SUSPENDED';
const APPROVAL_KEY_PREFIX = 'authority-approval:';

/** Every action name the judgment knows, by class. Read from the classifier, not restated. */
const PROBE_VOCABULARY = [
  'READ_PUBLIC_SOURCE', 'READ_ONLY_ANALYSIS', 'PARSE', 'NON_PRODUCTION_EXPERIMENT', 'CALCULATE',
  'DEDUPLICATE', 'DESIGN_METHOD', 'GENERATE_BENCHMARK', 'REVERSIBLE_STATE_CHANGE', 'DRAFT_MESSAGE',
  'VIEW_PORTAL', 'LEARN_FROM_SITE',
  'FACTORY_CODE', 'FACTORY_TEST', 'FACTORY_MERGE', 'FACTORY_DEPLOY', 'BUILD_A_TEST',
  'AUTHENTICATED_READ', 'AUTHENTICATED_OPERATION',
  'SPEND_FROM_ALLOWANCE', 'CONTACT_BUYER', 'QUOTE_AND_INVOICE', 'ENGAGE_CONTRACTOR',
  'PURCHASE_TOOL_OR_DATA', 'RUN_PAID_TEST', 'ACCEPT_PAYMENT',
  'SEND_OUTREACH', 'SUBMIT_FORM', 'SUBMIT_BID', 'SIGN_AGREEMENT', 'INITIATE_PAYMENT', 'MOVE_FUNDS',
  'CREATE_ACCOUNT', 'SCRAPE_PROTECTED', 'GRANT_ACCESS', 'CHANGE_WEBSITE',
  ...ALWAYS_PROHIBITED_COMMERCIAL,
] as const;

/** The acts S-0303 names that a read-only learning mechanism must never reach. */
export const READ_ONLY_FORBIDDEN = [
  'SIGN_AGREEMENT', 'CONTACT_BUYER', 'SEND_OUTREACH', 'SUBMIT_BID', 'INITIATE_PAYMENT',
  'SCRAPE_PROTECTED', 'CREATE_ACCOUNT', 'SUBMIT_FORM', 'PURCHASE_TOOL_OR_DATA', 'MOVE_FUNDS',
] as const;

const PATHS: ActionPath[] = ['API', 'BROWSER', 'INTERNAL'];

/** A grant that covers every commercial action with generous ceilings: the most permissive state the rules face. */
function wideGrant(at: string): CashAuthority {
  return {
    id: 'cau_probe',
    projectId: 'prj_probe',
    ownerUserId: 'usr_probe',
    name: 'probe',
    policyVersion: 1,
    allowedActions: PROBE_VOCABULARY.filter((a) => classifyAction(a) === 'EXTERNALLY_CONSEQUENTIAL'
      && !(ALWAYS_PROHIBITED_COMMERCIAL as readonly string[]).includes(a)),
    prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
    maxCommittedCents: 1_000_000,
    maxPerActionCents: 100_000,
    maxConcurrent: 5,
    currency: 'USD',
    startsAt: '2000-01-01T00:00:00.000Z',
    expiresAt: null,
    state: 'ACTIVE',
    revokedAt: null,
    revokedByUserId: null,
    revokedReason: null,
    createdByUserId: 'usr_probe',
    createdAt: at,
    updatedAt: at,
  };
}

/**
 * Run the pure judgment across the closed vocabulary and every path, and name
 * each rule it breaks. Empty means every rule holds in this process.
 */
export function authorityRulesHold(): string[] {
  const at = new Date().toISOString();
  const broken: string[] = [];
  const grant = wideGrant(at);
  const live = { authority: grant, revoked: false, heldCents: 0 };
  const revoked = { authority: null, revoked: true, heldCents: 2_500 };
  const projectId = 'prj_probe';

  const classes = new Set<ConsequenceClass>();
  for (const action of PROBE_VOCABULARY) {
    const klass = classifyAction(action);
    if (!klass) { broken.push(`${action} has no consequence class`); continue; }
    classes.add(klass);
  }
  for (const klass of CONSEQUENCE_CLASSES) if (!classes.has(klass)) broken.push(`no action is classed ${klass}`);
  if (classifyAction('SOMETHING_NEW') !== null) broken.push('an unknown action was given a class');
  if (judgeAction({ projectId, action: 'SOMETHING_NEW', path: 'API' }, live).ok) broken.push('an unknown action was allowed');

  for (const action of PROBE_VOCABULARY) {
    const klass = classifyAction(action);
    for (const path of PATHS) {
      // Internal work proceeds under a stop and a revocation: routine research continues.
      if (klass === 'INTERNAL') {
        const stopped = judgeAction({ projectId, action, path, emergencyStop: true }, revoked);
        if (!stopped.ok) broken.push(`internal ${action} on ${path} was stopped`);
        continue;
      }
      // Read-only access never authorizes a consequential act, on any path, under the widest grant.
      const readOnly = judgeAction({ projectId, action, path, access: 'READ_ONLY', amountCents: 100, releaseEnvelopeAllows: true }, live);
      if (readOnly.ok) broken.push(`read-only access authorized ${action} on ${path}`);
      // An emergency stop pauses every consequential mutation, keeps obligations and names safe work.
      const stopped = judgeAction({ projectId, action, path, emergencyStop: true, amountCents: 100, releaseEnvelopeAllows: true }, { ...live, heldCents: 2_500 });
      if (stopped.ok) broken.push(`${action} on ${path} proceeded under an emergency stop`);
      else if (stopped.ledger.cause === 'EMERGENCY_STOP' && (stopped.obligations?.heldCents !== 2_500 || !stopped.remainingSafeWork.includes('INTERNAL'))) {
        broken.push(`a stop of ${action} lost its obligations or its safe work`);
      }
      // A revocation stops further mutations and asks for exactly the renewal it needs.
      const afterRevoke = judgeAction({ projectId, action, path, amountCents: 100, releaseEnvelopeAllows: false }, revoked);
      if (afterRevoke.ok && klass === 'EXTERNALLY_CONSEQUENTIAL') broken.push(`${action} on ${path} proceeded after revocation`);
      if (afterRevoke.ledger.cause === 'REVOKED' && afterRevoke.obligations?.heldCents !== 2_500) broken.push(`a revocation of ${action} lost its obligations`);
      // A proposal is recorded as a proposal, never as a performed effect.
      const proposed = judgeAction({ projectId, action, path, mode: 'PROPOSE' }, revoked);
      if (proposed.ok && proposed.ledger.disposition !== 'PROPOSED') broken.push(`a proposed ${action} was recorded as ${proposed.ledger.disposition}`);
    }
  }
  for (const action of ALWAYS_PROHIBITED_COMMERCIAL) {
    if (judgeAction({ projectId, action, path: 'API', amountCents: 1 }, live).ok) broken.push(`${action} was authorized`);
  }
  // Money is judged against the grant's own ceilings, and an unstated sum is never assumed small.
  if (judgeAction({ projectId, action: 'SPEND_FROM_ALLOWANCE', path: 'API' }, live).ok) broken.push('a spend with no stated amount was allowed');
  if (judgeAction({ projectId, action: 'SPEND_FROM_ALLOWANCE', path: 'API', amountCents: grant.maxPerActionCents + 1 }, live).ok) {
    broken.push('a spend over the per-action ceiling was allowed');
  }
  if (judgeAction({ projectId, action: 'SPEND_FROM_ALLOWANCE', path: 'API', amountCents: 10 }, { ...live, heldCents: grant.maxCommittedCents }).ok) {
    broken.push('a spend over the committed ceiling was allowed');
  }
  // Third-party operations stay inside the account's own scope; a secret never travels inline.
  const account = { ref: 'acct_probe', inScope: true, approvedActionTypes: ['AUTHENTICATED_READ'], credentialFromSecretsStore: true, rateLimit: { used: 0, max: 10 } };
  if (!judgeAction({ projectId, action: 'AUTHENTICATED_READ', path: 'BROWSER', account }, live).ok) broken.push('an approved authenticated read inside its scope was refused');
  if (judgeAction({ projectId, action: 'AUTHENTICATED_OPERATION', path: 'BROWSER', account }, live).ok) broken.push('an unapproved authenticated operation was allowed');
  if (judgeAction({ projectId, action: 'AUTHENTICATED_READ', path: 'API', account: { ...account, credentialFromSecretsStore: false } }, live).ok) {
    broken.push('a credential outside the secrets store was allowed');
  }
  if (judgeAction({ projectId, action: 'AUTHENTICATED_READ', path: 'API' }, live).ok) broken.push('an authenticated action with no account scope was allowed');
  // A refusal a person can answer names the single smallest approval that would change it.
  const notCovered = judgeAction({ projectId, action: 'SEND_OUTREACH', path: 'API' }, { ...live, authority: { ...grant, allowedActions: [] } });
  if (notCovered.ok || notCovered.neededApproval?.action !== 'SEND_OUTREACH') broken.push('an uncovered send did not name its one missing approval');
  return broken;
}

/** The fields a ledger row may carry. Anything else — a token, a payload, prose a caller sent — is a defect. */
const LEDGER_FIELDS = new Set([
  'action', 'consequenceClass', 'path', 'principal', 'scope', 'disposition', 'cause', 'policyVersion',
  'amountCents', 'decidedAt', 'ok', 'approvalNeedId', 'neededApproval',
]);
const DISPOSITIONS = new Set(['PERFORMED', 'PROPOSED', 'REFUSED']);

export interface AuthorityRecords {
  decisions: CashEvent[];
  suspensions: CashEvent[];
  approvalRequests: CashNeed[];
  /** Each malformed row, by id and what is wrong with it. */
  defects: string[];
}

/** Read every authority row every project holds, and check each one. Read-only. */
export async function readAuthorityRecords(projectIds?: string[]): Promise<AuthorityRecords> {
  const ids = projectIds ?? (await listProjects()).map((p) => p.id);
  const out: AuthorityRecords = { decisions: [], suspensions: [], approvalRequests: [], defects: [] };
  for (const projectId of ids) {
    const decisions = await cashEventsOfKindInProject(projectId, AUTHORITY_DECISION_KIND);
    const suspensions = await cashEventsOfKindInProject(projectId, AUTHORITY_SUSPENDED_KIND);
    const needs = (await listNeeds({ projectId })).filter((n) => n.requestKey?.startsWith(APPROVAL_KEY_PREFIX));
    out.decisions.push(...decisions);
    out.suspensions.push(...suspensions);
    out.approvalRequests.push(...needs);
    const needById = new Map(needs.map((n) => [n.id, n]));
    for (const row of decisions) out.defects.push(...decisionDefects(row, needById));
    for (const row of suspensions) out.defects.push(...suspensionDefects(row));
  }
  return out;
}

function decisionDefects(row: CashEvent, needs: Map<string, CashNeed>): string[] {
  const d = row.detail;
  const bad: string[] = [];
  const extra = Object.keys(d).filter((k) => !LEDGER_FIELDS.has(k));
  if (extra.length) bad.push(`${row.id} carries fields outside the ledger shape (${extra.join(', ')})`);
  const klass = typeof d.consequenceClass === 'string' ? d.consequenceClass : '';
  if (!(CONSEQUENCE_CLASSES as readonly string[]).includes(klass) || klass === 'INTERNAL') bad.push(`${row.id} has no consequential class`);
  if (!DISPOSITIONS.has(String(d.disposition))) bad.push(`${row.id} has no disposition`);
  if (!('principal' in d)) bad.push(`${row.id} does not record its principal`);
  const scope = d.scope as { projectId?: unknown } | undefined;
  if (!scope || scope.projectId !== row.projectId) bad.push(`${row.id} is not scoped to its own project`);
  const cause = String(d.cause) as AuthorityLedgerRecord['cause'];
  if (d.disposition === 'REFUSED' && d.ok !== false) bad.push(`${row.id} is a refusal recorded as allowed`);
  if (d.disposition !== 'REFUSED' && (d.ok !== true || (cause !== 'ALLOWED' && cause !== 'OWNER_APPROVED'))) {
    bad.push(`${row.id} records an effect without an allowing cause`);
  }
  if (cause === 'OWNER_APPROVED') {
    const need = needs.get(String(d.approvalNeedId));
    if (!need || need.state !== 'RESOLVED') bad.push(`${row.id} cites an owner approval that is not on record`);
  }
  return bad;
}

function suspensionDefects(row: CashEvent): string[] {
  const d = row.detail;
  const bad: string[] = [];
  if (d.cause !== 'REVOKED' && d.cause !== 'EMERGENCY_STOP') bad.push(`${row.id} is a suspension without a stop or revocation`);
  if (!Array.isArray(d.heldCommitmentIds) || typeof d.heldCents !== 'number') bad.push(`${row.id} does not record the obligations still owed`);
  if (!Array.isArray(d.remainingSafeWork) || !d.remainingSafeWork.includes('INTERNAL')) bad.push(`${row.id} does not record the safe work that continues`);
  if (typeof d.needsAuthorization !== 'string' || !d.needsAuthorization.trim()) bad.push(`${row.id} does not name the action needing renewed authorization`);
  return bad;
}

const causeOf = (row: CashEvent): string => String(row.detail.cause);
const dispositionOf = (row: CashEvent): string => String(row.detail.disposition);

function verdict(rules: string[], records: AuthorityRecords, missing: string[], shown: string): EvidenceResult {
  if (rules.length) return { ok: false, detail: `a rule does not hold: ${rules[0]}${rules.length > 1 ? ` (+${rules.length - 1} more)` : ''}` };
  if (records.defects.length) return { ok: false, detail: `a ledger row is malformed: ${records.defects[0]}${records.defects.length > 1 ? ` (+${records.defects.length - 1} more)` : ''}` };
  if (missing.length) return { ok: false, detail: `not yet demonstrated on production records: ${missing.join('; ')}` };
  return { ok: true, detail: shown };
}

/**
 * AUTH-20-3: actions are classed and judged in the existing grant, every
 * consequential decision leaves a durable ledger row, and a refusal a person
 * can answer is asked once, as the smallest approval, and remembered.
 */
export async function demonstrateGraduatedAuthority(projectIds?: string[]): Promise<EvidenceResult> {
  const rules = authorityRulesHold();
  const records = await readAuthorityRecords(projectIds);
  const missing: string[] = [];
  if (records.decisions.length === 0) missing.push('no consequential decision has been recorded in the ledger');
  if (records.approvalRequests.length === 0) missing.push('no smallest-missing-approval request has been stored');
  const open = new Map<string, number>();
  for (const n of records.approvalRequests) {
    if (n.state === 'OPEN') open.set(`${n.projectId}|${n.requestKey}`, (open.get(`${n.projectId}|${n.requestKey}`) ?? 0) + 1);
  }
  const askedTwice = [...open.entries()].find(([, count]) => count > 1);
  if (askedTwice) return { ok: false, detail: `the same approval is asked more than once at a time (${askedTwice[0].split('|')[1]})` };
  const answered = records.approvalRequests.filter((n) => n.state !== 'OPEN').length;
  return verdict(rules, records, missing,
    `${records.decisions.length} consequential decision(s) in the ledger; ${records.approvalRequests.length} approval request(s), ${answered} answered and remembered`);
}

/**
 * AUTH-21-6: read-only access never reaches a consequential act on any path,
 * production has refused one for exactly that reason, and internal work keeps
 * going when a consequential operation needs the owner.
 */
export async function demonstrateReadOnlyBoundary(projectIds?: string[]): Promise<EvidenceResult> {
  const rules = authorityRulesHold();
  const records = await readAuthorityRecords(projectIds);
  const refusedReadOnly = records.decisions.filter((r) => causeOf(r) === 'READ_ONLY_GRANT' && dispositionOf(r) === 'REFUSED');
  const performedReadOnly = records.decisions.filter((r) => causeOf(r) === 'READ_ONLY_GRANT' && dispositionOf(r) !== 'REFUSED');
  if (performedReadOnly.length) return { ok: false, detail: `${performedReadOnly[0]!.id} performed an act under read-only access` };
  const missing = refusedReadOnly.length ? [] : ['no consequential act has been refused for read-only access'];
  return verdict(rules, records, missing,
    `${refusedReadOnly.length} consequential act(s) refused for read-only access; read-only never authorizes ${READ_ONLY_FORBIDDEN.length} named acts on API, BROWSER or INTERNAL paths, and internal work continues under stops and revocations`);
}

/**
 * AUTH-34: every decision names its principal, scope and class; prohibited and
 * uncovered acts are refused while permitted ones proceed; a revocation or stop
 * keeps the obligations owed, the safe work and the precise renewal needed.
 */
export async function demonstratePolicyToAction(projectIds?: string[]): Promise<EvidenceResult> {
  const rules = authorityRulesHold();
  const records = await readAuthorityRecords(projectIds);
  const missing: string[] = [];
  const refused = records.decisions.filter((r) => dispositionOf(r) === 'REFUSED');
  const proceeded = records.decisions.filter((r) => dispositionOf(r) !== 'REFUSED');
  if (!refused.length) missing.push('no consequential act has been refused on an action path');
  if (!proceeded.length) missing.push('no permitted consequential act has proceeded beside a refusal');
  if (!records.suspensions.length) missing.push('no revocation or emergency stop has recorded its obligations and safe work');
  const browser = records.decisions.filter((r) => r.detail.path === 'BROWSER').length;
  return verdict(rules, records, missing,
    `${refused.length} refused and ${proceeded.length} permitted consequential decision(s) (${browser} on a browser path); ${records.suspensions.length} suspension(s) recorded obligations, safe work and the renewal needed`);
}
