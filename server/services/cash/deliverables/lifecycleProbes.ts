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
 * `r01.life-29-3` — every exception the rows show for such a deal is on record as
 * `exception.detected` (written by the journey tick), and at least one real, sourced
 * case has been traced from request to accepted fulfilment including its failure
 * path (`rehearsal.traced`, valid, with a source and exceptions). A deal's exception
 * the tick has not yet recorded, or no rehearsed case at all, is a failure: nothing
 * to look at is not a demonstration (§39).
 *
 * `r01.life-29-2` — every declared obligation has a delivery plan on record
 * (`delivery.realized`, written by the journey tick) whose steps are the agreement's
 * own deliverable, never assigned to the buyer; its recorded delivery, acceptance and
 * redo reading is re-derived from the fulfilment rows and must agree; at least one
 * delivery has been accepted with evidence; and every accepted delivery's buyer has
 * its aftercare on record (`aftercare.recorded`), which arrangement construction
 * reads. No declared obligation, or none accepted, is a failure: nothing to look at
 * is not a demonstration (§39).
 *
 * Registered here because `probes.ts` is a protected path; `exceptions.ts` imports
 * this module so it is registered wherever the journey tick loads.
 */
import { getDb } from '../../../db/database.ts';
import { registerProbe, type ProbeResult } from '../../factory/program/probes.ts';
import type { CommitmentReading } from './commitments.ts';

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

export async function exceptionsHoldOnRows(): Promise<ProbeResult> {
  const { readCommitments } = await import('./commitments.ts');
  const { detectExceptions } = await import('./exceptions.ts');
  const db = getDb();
  const deals = await dealsWithAgreements();
  if (deals.length === 0) return { ok: false, detail: 'no opportunity has an agreement: no transaction whose exceptions can be read' };
  let detected = 0;
  for (const deal of deals) {
    const reading = await readCommitments({ projectId: deal.project_id, opportunityId: deal.opportunity_id, currency: deal.currency });
    const rows = detectExceptions(reading).filter((e) => e.source === 'ROWS');
    if (rows.length === 0) continue;
    const recorded = await db.all<{ detail: string }>(`SELECT detail FROM cash_events WHERE opportunity_id = ? AND kind = 'exception.detected'`, [deal.opportunity_id]);
    const ids = new Set(recorded.map((r) => String((JSON.parse(r.detail) as { exceptionId?: unknown }).exceptionId ?? '')));
    const missing = rows.find((e) => !ids.has(e.id));
    if (missing) return { ok: false, detail: `opportunity ${deal.opportunity_id}: exception ${missing.id} is shown by the rows but not on record` };
    detected += rows.length;
  }
  const traces = await db.all<{ id: string; detail: string }>(`SELECT id, detail FROM cash_events WHERE kind = 'rehearsal.traced' ORDER BY created_at, id`);
  const demonstrated = traces.filter((t) => {
    const d = JSON.parse(t.detail) as { valid?: boolean; sourceRef?: string | null; exceptions?: unknown[] };
    return d.valid === true && typeof d.sourceRef === 'string' && d.sourceRef.trim() !== '' && Array.isArray(d.exceptions) && d.exceptions.length > 0;
  });
  if (demonstrated.length === 0) {
    return { ok: false, detail: `${detected} exception(s) detected and on record, but no valid, sourced rehearsal with a failure path has been traced yet (${traces.length} rehearsal trace(s) in all)` };
  }
  return { ok: true, detail: `${detected} exception(s) shown by the rows are all on record; ${demonstrated.length} sourced rehearsal(s) traced including a failure path` };
}

interface RecordedRealization {
  agreementId?: unknown;
  plan?: { steps?: { promise?: unknown; fulfiller?: { ref?: unknown } | null }[] };
  realization?: { delivered?: unknown; accepted?: unknown; rejected?: unknown; redoObligations?: { stepKey?: unknown; open?: unknown }[] };
}

const sameList = (a: unknown, b: readonly string[]): boolean =>
  Array.isArray(a) && a.length === b.length && [...a].map(String).sort().join('\u0000') === [...b].sort().join('\u0000');

export async function realizationHoldsOnRows(): Promise<ProbeResult> {
  const { DELIVERY_REALIZED_EVENT, AFTERCARE_EVENT, readObligationRows, realizationOfObligation, partyKey } = await import('./realization.ts');
  const db = getDb();
  const declared = await db.all<{ project_id: string; opportunity_id: string; currency: string }>(
    `SELECT DISTINCT f.project_id AS project_id, f.opportunity_id AS opportunity_id, a.currency AS currency
       FROM cash_fulfillments f JOIN cash_agreements a ON a.id = f.agreement_id
      WHERE a.released_at IS NULL ORDER BY f.project_id, f.opportunity_id`,
  );
  if (declared.length === 0) return { ok: false, detail: 'no obligation has been declared on a live agreement: no delivery to derive from a scope' };
  let obligations = 0;
  let accepted = 0;
  let aftercare = 0;
  for (const deal of declared) {
    const recorded = await db.all<{ detail: string }>(
      `SELECT detail FROM cash_events WHERE opportunity_id = ? AND kind = ? ORDER BY created_at, id`,
      [deal.opportunity_id, DELIVERY_REALIZED_EVENT],
    );
    const latest = new Map<string, RecordedRealization>();
    for (const row of recorded) {
      const detail = JSON.parse(row.detail) as RecordedRealization;
      if (typeof detail.agreementId === 'string') latest.set(detail.agreementId, detail);
    }
    const afterKeys = new Set(
      (await db.all<{ detail: string }>(`SELECT detail FROM cash_events WHERE opportunity_id = ? AND kind = ?`, [deal.opportunity_id, AFTERCARE_EVENT]))
        .map((row) => String((JSON.parse(row.detail) as { aftercareKey?: unknown }).aftercareKey ?? '')),
    );
    for (const rows of await readObligationRows(deal.project_id, deal.opportunity_id, deal.currency)) {
      const id = rows.agreement.id;
      const on = latest.get(id);
      if (!on) return { ok: false, detail: `agreement ${id} has a declared obligation but no delivery plan on record` };
      const steps = on.plan?.steps ?? [];
      if (steps.length === 0 || steps.some((s) => s.promise !== rows.agreement.deliverable)) {
        return { ok: false, detail: `agreement ${id}: the recorded plan is not derived from the agreed deliverable` };
      }
      if (steps.some((s) => typeof s.fulfiller?.ref === 'string' && partyKey(rows.payer) !== '' && s.fulfiller.ref === `buyer:${partyKey(rows.payer)}`)) {
        return { ok: false, detail: `agreement ${id}: the buyer is recorded as its own fulfiller` };
      }
      // Re-derived a second way from the fulfilment rows; the capability readings do not enter these lists.
      const now = realizationOfObligation(rows, new Map()).realization;
      const was = on.realization ?? {};
      if (!sameList(was.delivered, now.delivered) || !sameList(was.accepted, now.accepted) || !sameList(was.rejected, now.rejected)) {
        return { ok: false, detail: `agreement ${id}: the recorded delivery and acceptance disagree with the fulfilment rows` };
      }
      const openNow = now.redoObligations.filter((r) => r.open).map((r) => r.stepKey);
      const openWas = (was.redoObligations ?? []).filter((r) => r.open === true).map((r) => String(r.stepKey));
      if (!sameList(openWas, openNow)) return { ok: false, detail: `agreement ${id}: the recorded redo obligations disagree with the fulfilment rows` };
      obligations += 1;
      if (now.accepted.includes(id)) {
        accepted += 1;
        if (partyKey(rows.payer) !== '') {
          if (!afterKeys.has(`SATISFACTION:${id}`)) return { ok: false, detail: `agreement ${id} was accepted but its buyer's aftercare is not on record` };
          aftercare += 1;
        }
      }
    }
  }
  if (accepted === 0) {
    return { ok: false, detail: `${obligations} obligation(s) planned from their agreed scope, but no delivery has been accepted with evidence yet` };
  }
  return { ok: true, detail: `${obligations} obligation(s) planned from their agreed scope and re-derived from their rows; ${accepted} accepted with evidence; ${aftercare} buyer aftercare record(s) on record for construction` };
}

registerProbe(COMMITMENT_PROBE, commitmentsHoldOnRows);
registerProbe(REALIZATION_PROBE, realizationHoldsOnRows);
registerProbe(EXCEPTION_PROBE, exceptionsHoldOnRows);
