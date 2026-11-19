/**
 * How an AgentRx finding is filed into Hermes' inventory (§109). Pure, so the
 * rule is tested without a database.
 *
 * The inventory is the operator's register: `inventoryDeficiencies` offers its
 * unclaimed findings to Hermes every run, and the director decides on them.
 * AgentRx findings are keyed `RX-<work type>-<failure category>` (export.ts), so
 * one cause seen on many items is one finding, refreshed by each diagnosis.
 *
 *   - A new finding is created with the diagnosis and its status
 *     (ROOT_CAUSE_CONFIRMED only when AgentRx's own stages agree, to_finding.py).
 *   - An unclaimed finding (DISCOVERED / ROOT_CAUSE_CONFIRMED, no owner) takes
 *     the newer diagnosis. A suspected diagnosis never downgrades a confirmed one.
 *   - A finding somebody owns or is repairing is not rewritten: the diagnosis
 *     goes into its note only, for the owner to read.
 *   - A VERIFIED_FIXED finding whose class failed again after the verification
 *     is reopened (DISCOVERED): the fix did not hold. Other closed statuses
 *     (a person's judgement) keep their status; the note records the recurrence.
 */
import type { InventoryItem } from '../../server/domain/operator.ts';

/**
 * The inventory finding a failure class is filed under: `RX-<work type>-<failure category>`, so
 * one cause seen on many items is one finding (the inventory id allows 48 characters).
 */
export function findingId(workType: string, failureCategory: string | null): string {
  const part = (s: string): string => s.replace(/[^A-Za-z0-9_]/g, '_');
  return `RX-${part(workType)}-${part(failureCategory ?? 'FAILED')}`.slice(0, 48);
}

export interface AgentRxFinding {
  id: string;
  confidence: 'CONFIRMED' | 'SUSPECTED' | 'INCONCLUSIVE';
  status: 'ROOT_CAUSE_CONFIRMED' | 'DISCOVERED';
  capability: string;
  symptom: string;
  evidence: string;
  root_cause: string | null;
  severity: 'BLOCKING' | 'MAJOR' | 'MINOR';
  verification_criteria: string;
  note: string;
  failedAt: string | null;
}

export interface FilingUpsert {
  id: string;
  capability?: string;
  symptom?: string;
  evidence?: string;
  rootCause?: string | null;
  severity?: string;
  verificationCriteria?: string;
  status?: string;
  note: string;
}

type Existing = Pick<InventoryItem, 'status' | 'owner' | 'rootCause' | 'verification'> & { updatedAt?: string | null };

const UNCLAIMED = ['DISCOVERED', 'ROOT_CAUSE_CONFIRMED'];

export function planFiling(existing: Existing | null, f: AgentRxFinding): FilingUpsert {
  const full = {
    id: f.id,
    capability: f.capability,
    symptom: f.symptom,
    evidence: f.evidence,
    severity: f.severity,
    verificationCriteria: f.verification_criteria,
    note: f.note,
  };
  if (!existing) {
    return { ...full, rootCause: f.root_cause, ...(f.status === 'ROOT_CAUSE_CONFIRMED' ? { status: f.status } : {}) };
  }
  if (UNCLAIMED.includes(existing.status) && !existing.owner) {
    // A suspected or inconclusive reading does not replace a cause already confirmed.
    if (existing.status === 'ROOT_CAUSE_CONFIRMED' && f.confidence !== 'CONFIRMED') {
      return { ...full, note: `${f.note} (A later AgentRx reading was ${f.confidence}; the confirmed cause stands.)`.slice(0, 1500) };
    }
    return {
      ...full,
      rootCause: f.root_cause ?? existing.rootCause,
      ...(f.status === 'ROOT_CAUSE_CONFIRMED' && existing.status !== 'ROOT_CAUSE_CONFIRMED' ? { status: f.status } : {}),
    };
  }
  // The stored verification carries when it was recorded (inventory.ts verificationRecord); the row's update time otherwise.
  const verifiedAt = (existing.verification as { recordedAt?: string } | null)?.recordedAt ?? existing.updatedAt ?? null;
  if (existing.status === 'VERIFIED_FIXED' && f.failedAt && verifiedAt && f.failedAt > verifiedAt) {
    return {
      ...full,
      rootCause: f.root_cause ?? existing.rootCause,
      status: 'DISCOVERED',
      note: `Reopened by AgentRx: this class failed again at ${f.failedAt}, after the fix was verified at ${verifiedAt}. ${f.note}`.slice(0, 1500),
    };
  }
  return { id: f.id, note: `AgentRx (${f.confidence}) on a later failure${f.failedAt ? ` at ${f.failedAt}` : ''}: ${f.note}`.slice(0, 1500) };
}
