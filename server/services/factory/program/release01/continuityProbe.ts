/**
 * Production probes for CONT-35 (business continuity across a partial failure)
 * and LEARN-15-1 (a prediction ledger whose misses are diagnosed and corrected),
 * read from the rows the delivered code writes and nothing else.
 *
 * CONT-35 reads `idempotency_operations` and `effect_attempts` (the effects
 * engine's own record, §20, invariants 25-26) for external effects only — an
 * attempt with an adapter. Its acceptance demonstration is a transaction
 * interrupted at a dangerous boundary and reconciled without duplication, so:
 *  - FAIL: one operation with more than one confirmed external effect (a
 *    commitment made twice), or a confirmed effect with no provider receipt.
 *  - PASS: at least one operation whose outcome became uncertain mid-effect is
 *    now resolved, with at most one confirmed effect — and nothing duplicated.
 *  - UNKNOWN: no external effect has yet been interrupted and resolved.
 *
 * LEARN-15-1 reads the forecast ledger (`bin_events` of FORECAST_PREDICTION,
 * FORECAST_EXPOSURE and FORECAST_OUTCOME, `measures = { ledger, row }`):
 *  - FAIL: a prediction without its outcome, population or comparable bucket,
 *    or an outcome against a version the ledger never recorded.
 *  - PASS: versioned predictions, exposures and observed outcomes on record —
 *    the material calibration is judged on.
 *  - UNKNOWN: nothing predicted, or nothing yet observed against a prediction.
 */
import { getDb } from '../../../../db/database.ts';
import type { ProbeResult } from '../probes.ts';

/* ------------------------------------------------------------------------- */
/* CONT-35                                                                    */
/* ------------------------------------------------------------------------- */

export interface AttemptRow {
  operation_id: string;
  state: string;
  phase: string;
  outcome: string | null;
  receipt_ref: string | null;
}

/** CONT-35 on given rows. Pure. */
export function continuityHolds(rows: readonly AttemptRow[]): ProbeResult {
  if (rows.length === 0) return { ok: null, detail: 'no external effect attempted yet: continuity across a failure is not demonstrated' };
  const byOp = new Map<string, AttemptRow[]>();
  for (const r of rows) byOp.set(r.operation_id, [...(byOp.get(r.operation_id) ?? []), r]);
  let reconciled = 0;
  let unresolved = 0;
  for (const [op, attempts] of byOp) {
    const confirmed = attempts.filter((a) => a.phase === 'CONFIRMED' || a.outcome === 'SUCCEEDED');
    if (confirmed.length > 1) return { ok: false, detail: `operation ${op} carries ${confirmed.length} confirmed external effects: a commitment was made twice` };
    if (confirmed.some((a) => !(a.receipt_ref ?? '').trim())) return { ok: false, detail: `operation ${op} is confirmed with no provider receipt` };
    const interrupted = attempts.some((a) => a.phase === 'UNCERTAIN' || a.outcome === 'UNCERTAIN');
    if (!interrupted) continue;
    const state = attempts[0]!.state;
    if (state === 'SUCCEEDED' || state === 'FAILED') reconciled += 1;
    else unresolved += 1;
  }
  if (reconciled === 0) {
    return {
      ok: null,
      detail: `${byOp.size} external operation(s), none duplicated; ${unresolved} interrupted and still awaiting reconciliation, none yet interrupted and resolved`,
    };
  }
  return {
    ok: true,
    detail: `${reconciled} external operation(s) interrupted at an uncertain boundary and resolved without a second effect; ${byOp.size} external operation(s) in all, none duplicated, every confirmation carries its receipt (${unresolved} still awaiting reconciliation)`,
  };
}

export async function continuityOnRows(): Promise<ProbeResult> {
  const rows = await getDb().all<AttemptRow>(
    `SELECT a.operation_id, o.state, a.phase, a.outcome, a.receipt_ref
       FROM effect_attempts a JOIN idempotency_operations o ON o.id = a.operation_id
      WHERE a.adapter IS NOT NULL
      ORDER BY a.operation_id, a.attempt_number`,
  );
  return continuityHolds(rows);
}

/* ------------------------------------------------------------------------- */
/* LEARN-15-1                                                                 */
/* ------------------------------------------------------------------------- */

interface LedgerEntryRow {
  ledger: string;
  row: Record<string, unknown>;
}

function entriesOf(rows: readonly { measures: string | null }[]): LedgerEntryRow[] {
  const out: LedgerEntryRow[] = [];
  for (const r of rows) {
    try {
      const parsed = JSON.parse(r.measures ?? '{}') as { ledger?: unknown; row?: unknown };
      if (typeof parsed.ledger === 'string' && parsed.row && typeof parsed.row === 'object') {
        out.push({ ledger: parsed.ledger, row: parsed.row as Record<string, unknown> });
      }
    } catch {
      // A row that does not parse is not part of the ledger; it is neither counted nor guessed.
    }
  }
  return out;
}

const text = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;

/** LEARN-15-1 on given rows. Pure. */
export function ledgerHolds(rows: readonly { measures: string | null }[]): ProbeResult {
  const entries = entriesOf(rows);
  const predictions = entries.filter((e) => e.ledger === 'PREDICTION').map((e) => e.row);
  if (predictions.length === 0) return { ok: null, detail: 'no prediction on the forecast ledger yet' };
  for (const p of predictions) {
    if (!text(p.id) || !text(p.claimId) || !text(p.outcome) || !text(p.population) || !text(p.comparableKey)) {
      return { ok: false, detail: `prediction ${String(p.id ?? '?')} is missing its outcome, population or comparable bucket` };
    }
  }
  const ids = new Set(predictions.map((p) => p.id as string));
  const exposures = entries.filter((e) => e.ledger === 'EXPOSURE').map((e) => e.row);
  const outcomes = entries.filter((e) => e.ledger === 'OUTCOME').map((e) => e.row);
  const stray = [...exposures, ...outcomes].find((r) => !ids.has(r.predictionId as string));
  if (stray) return { ok: false, detail: `a ledger row judges version ${String(stray.predictionId)}, which the ledger never recorded` };
  const claims = new Set(predictions.map((p) => p.claimId as string));
  const revised = [...claims].filter((c) => predictions.filter((p) => p.claimId === c).length > 1).length;
  if (outcomes.length === 0) {
    return { ok: null, detail: `${predictions.length} version(s) of ${claims.size} claim(s) and ${exposures.length} exposure(s) on the ledger; no outcome observed yet, so calibration has nothing to judge` };
  }
  return {
    ok: true,
    detail: `${predictions.length} version(s) of ${claims.size} claim(s) (${revised} revised), ${exposures.length} exposure(s) and ${outcomes.length} observed outcome(s) on the forecast ledger, each against a recorded version`,
  };
}

export async function ledgerOnRows(): Promise<ProbeResult> {
  const rows = await getDb().all<{ measures: string | null }>(
    `SELECT measures FROM bin_events WHERE event_type IN ('FORECAST_PREDICTION', 'FORECAST_EXPOSURE', 'FORECAST_OUTCOME') ORDER BY at, id`,
  );
  return ledgerHolds(rows);
}
