/**
 * Production probes for the transaction lifecycle (LIFE-29-1, LIFE-29-2, LIFE-29-3).
 *
 * Both read rows, never a constructed case:
 *
 * `r01.life-29-1` — for every opportunity that has an agreement, the commitment
 * model read from its rows (`readCommitments`) states every stage on its own, and
 * is checked against the ledger counted a second way: a stage that needs money is
 * never reached without the entries that make it so — settled funds only where a
 * settlement was recorded, payment only where a customer payment was — so no one
 * "sale made" flag stands in for them. Every transition carries a holder, a deadline
 * field, an outcome and its evidence.
 *
 * `r01.life-29-3` — every exception the rows show for such a deal (the commitment
 * model's, and the scope changes, cancellations and disputes the buyer's recorded
 * answers show) is on record as
 * `exception.detected` (written by the journey tick), and at least one real, sourced
 * case has been traced end to end — from its request through accepted fulfilment
 * and funds reconciliation — including its failure path (`rehearsal.traced`, valid,
 * with a source, exceptions and every part of its span; `rehearsalDemonstrates`).
 * A deal's exception
 * the tick has not yet recorded, or no rehearsed case at all, is a failure: nothing
 * to look at is not a demonstration (§39).
 *
 * `r01.life-29-2` — for every opportunity with a live agreement, the journey tick
 * has recorded a `realization.read` whose fingerprint equals the reading recomputed
 * from the rows now (`readDealRealization`): delivery steps derived one per agreed
 * scope item, no step fulfilled by the buyer, no licensed or accountable step absorbed
 * by Brain's own capability, every accepted step delivered and accepted with evidence,
 * "realized" only when every step is accepted and no redo is open, and accounting
 * figures equal to the deal position's. Every aftercare record that states a value of
 * repeat business is one deal construction reads (`repeatBusinessObservations`). No
 * deal with a live agreement is a failure, never a pass on nothing (§39).
 *
 * Registered here because `probes.ts` is a protected path; `exceptions.ts` imports
 * this module so it is registered wherever the journey tick loads.
 */
import { getDb } from '../../../db/database.ts';
import { registerProbe, type ProbeResult } from '../../factory/program/probes.ts';
import type { CommitmentReading } from './commitments.ts';
import type { StoredRealization } from './realization.ts';

export const COMMITMENT_PROBE = 'r01.life-29-1';
export const EXCEPTION_PROBE = 'r01.life-29-3';
export const REALIZATION_PROBE = 'r01.life-29-2';

interface DealRef {
  project_id: string;
  opportunity_id: string;
  currency: string;
}

/** Why a commitment reading contradicts the ledger it was read from, or null. Pure. */
export function commitmentProblem(reading: CommitmentReading, ledger: { payments: number; settlements: number }): string | null {
  const stages = Object.values(reading.stages);
  if (stages.length < 5) return 'states too few stages to be a chain of commitments';
  if (reading.stages.FUNDS_SETTLED.state === 'REACHED' && ledger.settlements <= 0) return 'says funds settled with no settlement on the ledger';
  if (reading.stages.PAYMENT_AUTHORIZED.state === 'REACHED' && ledger.payments <= 0 && ledger.settlements <= 0) return 'says payment authorized with no payment on the ledger';
  if (ledger.settlements > 0 && reading.stages.FUNDS_SETTLED.state === 'NOT_REACHED') return 'has settled funds on the ledger yet does not show them settled';
  if (reading.stages.CASH_AVAILABLE.state === 'REACHED' && reading.stages.FUNDS_SETTLED.state !== 'REACHED') return 'says cash available that has not settled';
  if (reading.stages.MARGIN_EARNED.state === 'REACHED' && reading.stages.WORK_ACCEPTED.state !== 'REACHED') return 'says margin earned on work nobody accepted';
  for (const t of reading.transitions) {
    const id = t.id;
    // Rows can predate a field; a transition that cannot say who must do what, by when, with what outcome and evidence is not one.
    const loose = t as Partial<typeof t>;
    if (!loose.duty || typeof loose.duty.action !== 'string') return `transition ${id} records no duty`;
    if (!('deadline' in t)) return `transition ${id} has no deadline field`;
    if (!loose.outcome) return `transition ${id} has no outcome`;
    if (!Array.isArray(loose.evidence)) return `transition ${id} has no evidence list`;
  }
  return null;
}

async function dealsWithAgreements(): Promise<DealRef[]> {
  return getDb().all<DealRef>(
    `SELECT DISTINCT a.project_id AS project_id, a.opportunity_id AS opportunity_id, a.currency AS currency
       FROM cash_agreements a ORDER BY a.project_id, a.opportunity_id`,
  );
}

async function ledgerOf(deal: DealRef): Promise<{ payments: number; settlements: number }> {
  const rows = await getDb().all<{ kind: string; total: number }>(
    `SELECT kind, SUM(amount_cents) AS total FROM cash_money_entries
      WHERE project_id = ? AND opportunity_id = ? AND currency = ? AND kind IN ('CUSTOMER_PAYMENT', 'SETTLEMENT') GROUP BY kind`,
    [deal.project_id, deal.opportunity_id, deal.currency],
  );
  const total = (kind: string) => Number(rows.find((r) => r.kind === kind)?.total ?? 0);
  return { payments: total('CUSTOMER_PAYMENT'), settlements: total('SETTLEMENT') };
}

export async function commitmentsHoldOnRows(): Promise<ProbeResult> {
  const { readCommitments } = await import('./commitments.ts');
  const deals = await dealsWithAgreements();
  if (deals.length === 0) return { ok: false, detail: 'no opportunity has an agreement: no transaction to read as commitments' };
  let transitions = 0;
  let reached = 0;
  for (const deal of deals) {
    const reading = await readCommitments({ projectId: deal.project_id, opportunityId: deal.opportunity_id, currency: deal.currency });
    const problem = commitmentProblem(reading, await ledgerOf(deal));
    if (problem) return { ok: false, detail: `opportunity ${deal.opportunity_id} ${problem}` };
    transitions += reading.transitions.length;
    reached += Object.values(reading.stages).filter((s) => s.state === 'REACHED').length;
  }
  return { ok: true, detail: `${deals.length} transaction(s) read as commitments: ${transitions} transition(s), ${reached} stage(s) reached, each checked against the ledger; no single sale flag` };
}

/** The persisted `rehearsal.traced` detail, as far as the probe reads it. */
export interface StoredTraceDetail {
  valid?: boolean;
  sourceRef?: string | null;
  exceptions?: unknown[];
  request?: { at?: unknown; ref?: unknown } | null;
  endToEnd?: { requestTraced?: unknown; fulfilmentAccepted?: unknown; fundsSettled?: unknown; reconciled?: unknown } | null;
  reached?: unknown[];
  steps?: { kind?: unknown; ref?: unknown }[];
}

/**
 * Whether one stored trace demonstrates S-0460: valid, sourced, with a failure
 * path, and end to end — its request on record and traced as a step, work
 * accepted, funds settled and reconciled. The stage claims are read a second
 * way from `reached`, so a trace that says "end to end" without the stages to
 * show for it does not count. A trace written before the trace recorded its
 * span has none of this and does not count either. Pure.
 */
export function rehearsalDemonstrates(d: StoredTraceDetail): boolean {
  if (d.valid !== true) return false;
  if (typeof d.sourceRef !== 'string' || d.sourceRef.trim() === '') return false;
  if (!Array.isArray(d.exceptions) || d.exceptions.length === 0) return false;
  const span = d.endToEnd;
  if (!span || span.requestTraced !== true || span.fulfilmentAccepted !== true || span.fundsSettled !== true || span.reconciled !== true) return false;
  const reached = Array.isArray(d.reached) ? d.reached.map(String) : [];
  if (!['PAYMENT_AUTHORIZED', 'FUNDS_SETTLED', 'WORK_ACCEPTED'].every((stage) => reached.includes(stage))) return false;
  const requestRef = typeof d.request?.ref === 'string' ? d.request.ref : '';
  if (!requestRef || !Array.isArray(d.steps) || !d.steps.some((s) => s.ref === requestRef && s.kind === 'STATE_CHANGE')) return false;
  return true;
}

export async function exceptionsHoldOnRows(): Promise<ProbeResult> {
  const { detectFromRows } = await import('./exceptions.ts');
  const db = getDb();
  const deals = await dealsWithAgreements();
  if (deals.length === 0) return { ok: false, detail: 'no opportunity has an agreement: no transaction whose exceptions can be read' };
  let detected = 0;
  for (const deal of deals) {
    // The commitment rows and the buyer's recorded answers: a scope change or a dispute is checked like any other.
    const { detected: rows } = await detectFromRows({ projectId: deal.project_id, opportunityId: deal.opportunity_id, currency: deal.currency });
    if (rows.length === 0) continue;
    const recorded = await db.all<{ detail: string }>(`SELECT detail FROM cash_events WHERE opportunity_id = ? AND kind = 'exception.detected'`, [deal.opportunity_id]);
    const ids = new Set(recorded.map((r) => String((JSON.parse(r.detail) as { exceptionId?: unknown }).exceptionId ?? '')));
    const missing = rows.find((e) => !ids.has(e.id));
    if (missing) return { ok: false, detail: `opportunity ${deal.opportunity_id}: exception ${missing.id} is shown by the rows but not on record` };
    detected += rows.length;
  }
  const traces = await db.all<{ id: string; detail: string }>(`SELECT id, detail FROM cash_events WHERE kind = 'rehearsal.traced' ORDER BY created_at, id`);
  const demonstrated = traces.filter((t) => rehearsalDemonstrates(JSON.parse(t.detail) as StoredTraceDetail));
  if (demonstrated.length === 0) {
    return {
      ok: false,
      detail: `${detected} exception(s) detected and on record, but no valid, sourced rehearsal with a failure path has been traced end to end yet — from the request through accepted fulfilment and funds reconciliation (${traces.length} rehearsal trace(s) in all)`,
    };
  }
  return { ok: true, detail: `${detected} exception(s) shown by the rows are all on record; ${demonstrated.length} sourced rehearsal(s) traced end to end, from the request through accepted fulfilment and funds reconciliation, including a failure path` };
}

/** Why a realization reading breaks LIFE-29-2's rules, or null. Pure. */
export function realizationProblem(r: StoredRealization): string | null {
  const { plan, reading } = r;
  if (plan.steps.length !== r.scopeKeys.length) return `derives ${plan.steps.length} delivery step(s) from ${r.scopeKeys.length} scope item(s)`;
  const keys = new Set(r.scopeKeys);
  for (const step of plan.steps) {
    if (!keys.has(step.key)) return `has delivery step ${step.key}, which no agreed scope item states`;
    if (step.fulfiller && step.fulfiller.ref === r.buyerId) return `names the buyer as fulfiller of ${step.key}`;
    if (step.responsibility !== null && step.fulfiller?.kind === 'BRAIN_CAPABILITY') return `lets Brain absorb an accountable responsibility on ${step.key}`;
    if (step.status === 'ASSIGNED' && !step.fulfiller) return `calls ${step.key} assigned with no fulfiller`;
    if (step.status !== 'ASSIGNED' && step.reasons.length === 0) return `leaves ${step.key} unassigned without saying what is missing`;
  }
  for (const key of reading.accepted) if (!reading.delivered.includes(key)) return `accepts ${key}, which was never delivered with evidence`;
  if (reading.realized && (plan.steps.length === 0 || plan.steps.some((s) => !reading.accepted.includes(s.key)))) return 'says realized with a step not accepted';
  if (reading.realized && reading.redoObligations.some((o) => o.open)) return 'says realized with a redo obligation open';
  for (const key of reading.rejected) if (!reading.redoObligations.some((o) => o.stepKey === key && o.open)) return `has rejected ${key} with no open redo obligation`;
  return null;
}

export async function realizationHoldsOnRows(): Promise<ProbeResult> {
  const { readDealRealization, repeatBusinessObservations, REALIZATION_EVENT, AFTERCARE_EVENT } = await import('./realization.ts');
  const db = getDb();
  const deals = await db.all<DealRef>(
    `SELECT DISTINCT a.project_id AS project_id, a.opportunity_id AS opportunity_id, a.currency AS currency
       FROM cash_agreements a WHERE a.state = 'AGREED' ORDER BY a.project_id, a.opportunity_id`,
  );
  if (deals.length === 0) return { ok: false, detail: 'no opportunity has a live agreement: no delivery to derive from a scope' };
  let steps = 0;
  let accepted = 0;
  let realized = 0;
  for (const deal of deals) {
    const now = await readDealRealization({ projectId: deal.project_id, opportunityId: deal.opportunity_id, currency: deal.currency });
    if (!now) return { ok: false, detail: `opportunity ${deal.opportunity_id}: its realization cannot be read from its rows` };
    const problem = realizationProblem(now);
    if (problem) return { ok: false, detail: `opportunity ${deal.opportunity_id} ${problem}` };
    const last = await db.get<{ detail: string }>(
      `SELECT detail FROM cash_events WHERE opportunity_id = ? AND kind = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
      [deal.opportunity_id, REALIZATION_EVENT],
    );
    if (!last) return { ok: false, detail: `opportunity ${deal.opportunity_id}: no realization is on record (the journey tick has not read it)` };
    if ((JSON.parse(last.detail) as { fingerprint?: unknown }).fingerprint !== now.fingerprint) {
      return { ok: false, detail: `opportunity ${deal.opportunity_id}: the realization on record is not what its rows say now` };
    }
    steps += now.plan.steps.length;
    accepted += now.reading.accepted.length;
    if (now.reading.realized) realized += 1;
  }
  // Every valued repeat-business record is evidence deal construction reads.
  const projects = [...new Set(deals.map((d) => `${d.project_id}\u0000${d.currency}`))];
  let repeat = 0;
  for (const key of projects) {
    const [projectId, currency] = key.split('\u0000') as [string, string];
    const valued = await db.all<{ id: string; detail: string }>(`SELECT id, detail FROM cash_events WHERE project_id = ? AND kind = ?`, [projectId, AFTERCARE_EVENT]);
    const expected = valued.filter((e) => {
      const d = JSON.parse(e.detail) as { kind?: string; valueCents?: unknown; payer?: unknown };
      return ['FOLLOW_UP_REQUEST', 'RENEWAL', 'UPSELL', 'CROSS_SELL', 'REFERRAL'].includes(String(d.kind)) && typeof d.valueCents === 'number' && d.valueCents > 0 && typeof d.payer === 'string' && d.payer.trim() !== '';
    }).map((e) => `aftercare:${e.id}`);
    const read = new Set((await repeatBusinessObservations(projectId, currency)).map((o) => o.id));
    const unread = expected.find((id) => !read.has(id));
    if (unread) return { ok: false, detail: `${unread} states repeat business that deal construction does not read` };
    repeat += expected.length;
  }
  return {
    ok: true,
    detail: `${deals.length} deal(s): ${steps} delivery step(s) derived from agreed scope, ${accepted} accepted with evidence, ${realized} realized; each on record as read; ${repeat} repeat-business record(s) feeding deal construction`,
  };
}

registerProbe(COMMITMENT_PROBE, commitmentsHoldOnRows);
registerProbe(REALIZATION_PROBE, realizationHoldsOnRows);
registerProbe(EXCEPTION_PROBE, exceptionsHoldOnRows);
