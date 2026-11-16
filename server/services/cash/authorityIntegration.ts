/**
 * INT-38-AUTHORITY (S-0517): "all actions obey authority (§34)", read jointly
 * across the transaction lifecycle (LIFE-29) and the authority ledger (AUTH-34).
 *
 * This is the body the `r01.int-38-authority` probe can call. The registration
 * itself belongs under the protected verification path
 * (`server/services/factory/program/**`, §96), which an implementing campaign
 * may not write, so the check is not authored by the change it judges.
 *
 * It composes the readers that already exist rather than re-deriving them:
 *
 *   - `policyToActionEvidence` (AUTH-34): the ledger is complete, no
 *     consequential decision under a stop or outside a grant, suspensions keep
 *     their obligations, every effect receipt names its authorization;
 *   - `commitmentsHoldOnRows` / `exceptionsHoldOnRows` (LIFE-29-1/3): the
 *     lifecycle's own rows read as commitments and exceptions.
 *
 * and adds the cross-check neither holds alone: every consequential effect the
 * lifecycle recorded — a `cash_actions` row (a contact, an invoice issued, a
 * payment accepted, an execution begun), a PERFORMED `AUTHORITY_EFFECT`
 * receipt, a `remedy.carried_out` event — rests on an authority decision on the
 * AUTH-34 ledger (or a person's approval) for the same project and action,
 * made no later than the effect, with no emergency stop on and a grant in force
 * (or owner-approved); a remedy's recorded authority (remedy-authority-link)
 * agrees with the ledger row it cites; and every suspension still holds the
 * lifecycle commitments it says it holds.
 *
 * Read-only: nothing here writes a row, starts a timer or calls the judge on
 * live input. Zero lifecycle effects is answered as "nothing performed yet",
 * which is ok and is never presented as proof of anything (§47).
 */
import { getDb } from '../../db/database.ts';
import { listAuthorities, listCommitments } from '../../repos/cashAuthority.ts';
import {
  AUTHORITY_DECISION_KIND,
  AUTHORITY_EFFECT_KIND,
  EMERGENCY_RESUME_KIND,
  EMERGENCY_STOP_KIND,
  classifyAction,
} from './authority.ts';
import { AUTHORITY_SUSPENDED_KIND, policyToActionEvidence, policyToActionRule } from './authorityEvidence.ts';
import { commitmentsHoldOnRows, exceptionsHoldOnRows } from './deliverables/lifecycleProbes.ts';
import { REMEDY_CARRIED_OUT } from './deliverables/exceptions.ts';
import type { CashAuthority } from '../../domain/types.ts';
import type { ProbeResult } from '../factory/program/probes.ts';

export const INTEGRATION_AUTHORITY_PROBE = 'r01.int-38-authority';

/** Which lifecycle record an effect was read from. */
export type LifecycleEffectSource = 'CASH_ACTION' | 'EFFECT_RECEIPT' | 'REMEDY';

export interface AuthorityIntegrationCounts {
  decisions: number;
  effects: number;
  cashActions: number;
  effectReceipts: number;
  remedies: number;
  suspensions: number;
}

export interface AuthorityIntegrationReading extends ProbeResult {
  counts: AuthorityIntegrationCounts;
  /** The first row that breaks the joint reading, and why. Null when nothing does. */
  violation: { rowId: string; reason: string } | null;
}

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
  /** When the judgment was made (its own `decidedAt`), else when the row was written. */
  at: string;
  detail: Record<string, unknown>;
}

interface Effect {
  source: LifecycleEffectSource;
  id: string;
  projectId: string;
  action: string | null;
  at: string;
  detail: Record<string, unknown>;
}

interface Context {
  decisions: Decision[];
  byId: Map<string, Decision>;
  controls: EventRow[];
  grants: Map<string, CashAuthority[]>;
}

function parse(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function rowsOfKinds(kinds: readonly string[]): Promise<EventRow[]> {
  const marks = kinds.map(() => '?').join(', ');
  return getDb().all<EventRow>(
    `SELECT id, project_id, kind, detail, created_at FROM cash_events WHERE kind IN (${marks}) ORDER BY created_at, id`,
    [...kinds],
  );
}

/** A decision that let the action go ahead: AUTHORIZED, or the legacy PERFORMED label for the same thing. */
function granted(d: Decision): boolean {
  return (d.detail.disposition === 'AUTHORIZED' || d.detail.disposition === 'PERFORMED') && d.detail.ok === true;
}

/** AUTHORIZED and the legacy PERFORMED name one disposition. */
function normalDisposition(value: unknown): string | null {
  if (value === 'PERFORMED') return 'AUTHORIZED';
  return typeof value === 'string' ? value : null;
}

/**
 * Was the project's emergency stop on at `at`? Newest of stop/resume at or before it wins.
 *
 * At a judgment, a stop stamped in the same instant reads as on (the judge may
 * have read it). At an effect whose authorization was already made, a stop in
 * the same instant is not "before" it — the effect was in flight when the stop
 * committed — so `atEffect` counts only a stop strictly earlier.
 */
function stoppedAt(controls: readonly EventRow[], projectId: string, at: string, atEffect = false): boolean {
  let lastStop: string | null = null;
  let lastResume: string | null = null;
  for (const c of controls) {
    if (c.project_id !== projectId || c.created_at > at || (atEffect && c.created_at === at)) continue;
    if (c.kind === EMERGENCY_STOP_KIND) lastStop = c.created_at;
    else lastResume = c.created_at;
  }
  return lastStop !== null && (lastResume === null || lastResume <= lastStop);
}

/** Was some grant of the project in force at `at`? A revocation in the same instant came after the read that judged. */
function grantInForce(grants: readonly CashAuthority[], at: string): boolean {
  return grants.some((g) => g.startsAt <= at && (g.expiresAt === null || g.expiresAt > at) && (g.revokedAt === null || g.revokedAt >= at));
}

async function grantsOf(ctx: Context, projectId: string): Promise<CashAuthority[]> {
  let grants = ctx.grants.get(projectId);
  if (!grants) {
    grants = await listAuthorities(projectId);
    ctx.grants.set(projectId, grants);
  }
  return grants;
}

/**
 * Whether one authorizing decision was made with authority actually in hand:
 * no stop on at the moment it was made, and — for an externally consequential
 * act — a grant in force then, unless a person approved this very scope.
 */
async function decisionHadAuthority(ctx: Context, d: Decision): Promise<string | null> {
  if (stoppedAt(ctx.controls, d.projectId, d.at)) return `its authorization ${d.id} was made while the emergency stop was on`;
  if (d.detail.consequenceClass !== 'EXTERNALLY_CONSEQUENTIAL') return null;
  if (d.detail.cause === 'OWNER_APPROVED') return null;
  if (!grantInForce(await grantsOf(ctx, d.projectId), d.at)) return `its authorization ${d.id} was made with no grant in force and no owner approval`;
  return null;
}

/** Ledgered actions only: an internal or unknown action leaves no decision row, so it is not an effect this reading can hold to one. */
function consequential(action: string | null): boolean {
  if (!action) return false;
  const klass = classifyAction(action);
  return klass !== null && klass !== 'INTERNAL';
}

async function cashActionEffects(): Promise<Effect[]> {
  const rows = await getDb().all<{ id: string; project_id: string; authority_id: string; action: string; performed_by: string; created_at: string }>(
    'SELECT id, project_id, authority_id, action, performed_by, created_at FROM cash_actions ORDER BY created_at, id',
  );
  return rows
    .filter((r) => consequential(r.action))
    .map((r) => ({
      source: 'CASH_ACTION' as const,
      id: r.id,
      projectId: r.project_id,
      action: r.action,
      at: r.created_at,
      detail: { authorityId: r.authority_id, performedBy: r.performed_by },
    }));
}

/**
 * A `cash_actions` row cites no decision id, so it is held to the latest
 * authorizing decision on the ledger for its project and action made no later
 * than the row — the judgment that let it through — and that decision must
 * have had authority in hand. The grant the row names must belong to the
 * project and be in force at the effect, unless the owner approved the scope.
 */
async function checkCashAction(ctx: Context, e: Effect): Promise<string | null> {
  const prior = ctx.decisions.filter((d) => d.projectId === e.projectId && d.detail.action === e.action && d.at <= e.at && granted(d));
  const latest = prior[prior.length - 1];
  if (!latest) return `${e.action} was performed with no authorization decision on the ledger before it`;
  const missing = await decisionHadAuthority(ctx, latest);
  if (missing) return `${e.action} was performed, but ${missing}`;
  if (stoppedAt(ctx.controls, e.projectId, e.at, true)) return `${e.action} was performed while the emergency stop was on`;
  if (latest.detail.cause !== 'OWNER_APPROVED') {
    const grant = (await grantsOf(ctx, e.projectId)).find((g) => g.id === e.detail.authorityId);
    if (!grant) return `${e.action} names grant ${String(e.detail.authorityId)}, which is not a grant of its project`;
    if (!grantInForce([grant], e.at)) return `${e.action} was performed under grant ${grant.id}, which was not in force at the time`;
  }
  return null;
}

async function receiptEffects(): Promise<Effect[]> {
  const rows = await rowsOfKinds([AUTHORITY_EFFECT_KIND]);
  return rows
    .map((r) => ({ id: r.id, projectId: r.project_id, at: r.created_at, detail: parse(r.detail) }))
    .filter((r) => r.detail.disposition === 'PERFORMED')
    .map((r) => ({
      source: 'EFFECT_RECEIPT' as const,
      id: r.id,
      projectId: r.projectId,
      action: typeof r.detail.action === 'string' ? r.detail.action : null,
      at: r.at,
      detail: r.detail,
    }));
}

/** A PERFORMED receipt names its decision; that decision must have come first and had authority in hand. */
async function checkReceipt(ctx: Context, e: Effect): Promise<string | null> {
  const decision = typeof e.detail.decisionId === 'string' ? ctx.byId.get(e.detail.decisionId) : undefined;
  if (!decision) return `${String(e.action)} was performed with no authorization decision on the ledger`;
  if (!granted(decision) || decision.projectId !== e.projectId || decision.detail.action !== e.action) {
    return `${String(e.action)} was performed under decision ${decision.id}, which did not authorize it`;
  }
  if (decision.at > e.at) return `${String(e.action)} was performed before decision ${decision.id} authorized it`;
  const missing = await decisionHadAuthority(ctx, decision);
  return missing ? `${String(e.action)} was performed, but ${missing}` : null;
}

async function remedyEffects(): Promise<Effect[]> {
  const rows = await rowsOfKinds([REMEDY_CARRIED_OUT]);
  return rows.map((r) => {
    const detail = parse(r.detail);
    const authority = (detail.authority ?? null) as Record<string, unknown> | null;
    const action = authority && typeof authority.commercialAction === 'string' ? authority.commercialAction : null;
    return { source: 'REMEDY' as const, id: r.id, projectId: r.project_id, action, at: r.created_at, detail };
  });
}

/**
 * A carried-out remedy records the authority it acted under (remedy-authority-link).
 * Under a grant, that record must agree with the ledger decision it cites; under a
 * person's approval, the approval must be a request that person resolved, before
 * the effect, in the same project. Either way no stop may have been on.
 */
async function checkRemedy(ctx: Context, e: Effect): Promise<string | null> {
  const remedy = String(e.detail.remedy ?? 'remedy');
  const a = (e.detail.authority ?? null) as Record<string, unknown> | null;
  if (!a || typeof a !== 'object') return `${remedy} was carried out with no authority recorded`;
  if (a.allowed !== true) return `${remedy} was carried out under an authority record that did not allow it`;
  if (a.emergencyStop !== false || stoppedAt(ctx.controls, e.projectId, e.at, true)) return `${remedy} was carried out while the emergency stop was on`;
  if (a.basis === 'GRANT') {
    const decision = typeof a.decisionId === 'string' ? ctx.byId.get(a.decisionId) : undefined;
    if (!decision) return `${remedy} cites decision ${String(a.decisionId)}, which is not on the ledger`;
    if (!granted(decision) || decision.projectId !== e.projectId || decision.detail.action !== a.commercialAction) {
      return `${remedy} cites decision ${decision.id}, which did not authorize ${String(a.commercialAction)} in this project`;
    }
    if (decision.at > e.at) return `${remedy} was carried out before decision ${decision.id} authorized it`;
    if (a.cause !== decision.detail.cause) return `${remedy} records cause ${String(a.cause)}, but the ledger decision ${decision.id} says ${String(decision.detail.cause)}`;
    if (normalDisposition(a.disposition) !== normalDisposition(decision.detail.disposition)) {
      return `${remedy} records disposition ${String(a.disposition)}, but the ledger decision ${decision.id} says ${String(decision.detail.disposition)}`;
    }
    if (typeof a.policyVersion === 'number' && typeof decision.detail.policyVersion === 'number' && a.policyVersion !== decision.detail.policyVersion) {
      return `${remedy} records grant version ${a.policyVersion}, but the ledger decision ${decision.id} says ${decision.detail.policyVersion}`;
    }
    const missing = await decisionHadAuthority(ctx, decision);
    return missing ? `${remedy} was carried out, but ${missing}` : null;
  }
  if (a.basis === 'OWNER_APPROVAL') {
    if (a.cause !== 'OWNER_APPROVED' || normalDisposition(a.disposition) !== 'AUTHORIZED') return `${remedy} claims a person's approval but records ${String(a.cause)} / ${String(a.disposition)}`;
    if (typeof a.approvalRequestId !== 'string' || !a.approvalRequestId || typeof a.approvedBy !== 'string' || !a.approvedBy) {
      return `${remedy} claims a person's approval but names no approval request or approver`;
    }
    const need = await getDb().get<{ project_id: string; state: string; resolved_by_user_id: string | null; resolved_at: string | null }>(
      'SELECT project_id, state, resolved_by_user_id, resolved_at FROM cash_needs WHERE id = ?',
      [a.approvalRequestId],
    );
    if (!need || need.project_id !== e.projectId) return `${remedy} cites approval request ${a.approvalRequestId}, which is not a request of its project`;
    if (need.state !== 'RESOLVED' || need.resolved_by_user_id !== a.approvedBy) return `${remedy} cites approval request ${a.approvalRequestId}, which ${a.approvedBy} did not resolve`;
    if (need.resolved_at && need.resolved_at > e.at) return `${remedy} was carried out before approval request ${a.approvalRequestId} was resolved`;
    return null;
  }
  return `${remedy} was carried out on basis ${String(a.basis)}, which authorizes nothing`;
}

/** Every suspension still holds, as rows of its own project, the lifecycle commitments it says it holds. */
async function checkSuspensions(rows: readonly EventRow[]): Promise<{ rowId: string; reason: string } | null> {
  const commitments = new Map<string, Set<string>>();
  for (const row of rows) {
    const held = parse(row.detail).heldCommitmentIds;
    if (!Array.isArray(held)) return { rowId: row.id, reason: 'the suspension lost track of the commitments it holds' };
    let ids = commitments.get(row.project_id);
    if (!ids) {
      ids = new Set((await listCommitments(row.project_id)).map((c) => c.id));
      commitments.set(row.project_id, ids);
    }
    const lost = held.find((id) => !ids.has(String(id)));
    if (lost !== undefined) return { rowId: row.id, reason: `the suspension holds commitment ${String(lost)}, which its project no longer has` };
  }
  return null;
}

function fail(counts: AuthorityIntegrationCounts, rowId: string, reason: string): AuthorityIntegrationReading {
  return { ok: false, detail: `row ${rowId}: ${reason}`, counts, violation: { rowId, reason } };
}

/**
 * INT-38-AUTHORITY on production rows. `ok: true` only when AUTH-34's reading,
 * the LIFE-29 readings and the cross-check all hold; otherwise the first row
 * that breaks it and why. A LIFE-29 reading with nothing to read (no agreement
 * yet) is reported as such and is not a failure; one that fails is.
 */
export async function actionsObeyAuthorityOnRows(): Promise<AuthorityIntegrationReading> {
  const decisionRows = await rowsOfKinds([AUTHORITY_DECISION_KIND]);
  const decisions: Decision[] = decisionRows.map((r) => {
    const detail = parse(r.detail);
    const at = typeof detail.decidedAt === 'string' && detail.decidedAt ? detail.decidedAt : r.created_at;
    return { id: r.id, projectId: r.project_id, at, detail };
  });
  const [cashActions, receipts, remedies, suspensions, controls] = await Promise.all([
    cashActionEffects(),
    receiptEffects(),
    remedyEffects(),
    rowsOfKinds([AUTHORITY_SUSPENDED_KIND]),
    rowsOfKinds([EMERGENCY_STOP_KIND, EMERGENCY_RESUME_KIND]),
  ]);
  const effects = [...cashActions, ...receipts, ...remedies].sort((x, y) => (x.at === y.at ? x.id.localeCompare(y.id) : x.at < y.at ? -1 : 1));
  const counts: AuthorityIntegrationCounts = {
    decisions: decisions.length,
    effects: effects.length,
    cashActions: cashActions.length,
    effectReceipts: receipts.length,
    remedies: remedies.length,
    suspensions: suspensions.length,
  };

  // AUTH-34. With nothing ever judged and nothing performed there is no ledger to read, only the rule.
  if (decisions.length === 0 && effects.length === 0) {
    const rule = policyToActionRule();
    if (rule) return { ok: false, detail: `the AUTH-34 rule does not hold: ${rule}`, counts, violation: null };
  } else {
    const auth = await policyToActionEvidence();
    if (auth.ok !== true) return { ok: false, detail: `AUTH-34 does not hold: ${auth.detail}`, counts, violation: null };
  }

  // LIFE-29-1 and LIFE-29-3.
  const [commitments, exceptions] = await Promise.all([commitmentsHoldOnRows(), exceptionsHoldOnRows()]);
  if (commitments.ok === false) return { ok: false, detail: `LIFE-29-1 does not hold: ${commitments.detail}`, counts, violation: null };
  if (exceptions.ok === false) return { ok: false, detail: `LIFE-29-3 does not hold: ${exceptions.detail}`, counts, violation: null };

  // The cross-check.
  const ctx: Context = { decisions, byId: new Map(decisions.map((d) => [d.id, d])), controls, grants: new Map() };
  for (const e of effects) {
    const reason = e.source === 'CASH_ACTION' ? await checkCashAction(ctx, e) : e.source === 'EFFECT_RECEIPT' ? await checkReceipt(ctx, e) : await checkRemedy(ctx, e);
    if (reason) return fail(counts, e.id, reason);
  }
  const lost = await checkSuspensions(suspensions);
  if (lost) return fail(counts, lost.rowId, lost.reason);

  const lifecycle = `LIFE-29-1: ${commitments.ok === null ? `nothing to read (${commitments.detail})` : 'holds'}; LIFE-29-3: ${exceptions.ok === null ? `nothing to read (${exceptions.detail})` : 'holds'}`;
  if (effects.length === 0) {
    return {
      ok: true,
      detail: `nothing performed yet: no lifecycle effect is recorded, so there is no action for authority to have governed and this proves nothing about it; ${decisions.length} ledger decision(s), ${suspensions.length} suspension(s) keeping their commitments; ${lifecycle}`,
      counts,
      violation: null,
    };
  }
  return {
    ok: true,
    detail:
      `${effects.length} lifecycle effect(s) (${cashActions.length} recorded action(s), ${receipts.length} performed effect receipt(s), ${remedies.length} remedy(ies) carried out), ` +
      `each resting on a prior authority decision or owner approval among ${decisions.length} ledger decision(s), made with no emergency stop on and a grant in force or owner-approved; ` +
      `every remedy's recorded authority agrees with the ledger; ${suspensions.length} suspension(s), each still holding its commitments; AUTH-34 holds; ${lifecycle}`,
    counts,
    violation: null,
  };
}
