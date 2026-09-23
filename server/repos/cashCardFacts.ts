/**
 * Where each answer on an evidence card came from.
 *
 * One row per field, replaced rather than accumulated: two live answers to "who
 * pays" is a card that argues with itself. What accumulates is the *history*,
 * which is `cash_events` — a fact being corrected is an event, and the row here
 * is only ever what the card says now.
 *
 * `kind` is the load-bearing column. EVIDENCE resolves to a research claim and
 * therefore to a source URL, a publisher and a date. RECOMMENDATION is Brain's
 * own proposal and carries what it rests on, what it assumed and what would
 * change it. PERSON is somebody's decision, and nothing re-proposes over one.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import type { CashCardFact, CashCardFactRow } from '../domain/types.ts';

function mapFact(row: CashCardFactRow): CashCardFact {
  return {
    id: row.id,
    projectId: row.project_id,
    opportunityId: row.opportunity_id,
    field: row.field,
    kind: row.kind as CashCardFact['kind'],
    value: row.value,
    claimId: row.claim_id,
    needId: row.need_id,
    basis: row.basis,
    assumptions: row.assumptions,
    uncertainty: row.uncertainty,
    decidedBy: row.decided_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface NewCardFact {
  projectId: string;
  opportunityId: string;
  field: string;
  kind: CashCardFact['kind'];
  value: string;
  claimId?: string | null;
  needId?: string | null;
  basis?: string | null;
  assumptions?: string | null;
  uncertainty?: string | null;
  decidedBy: string;
}

/**
 * Record what a card field now says and where it came from.
 *
 * `ON CONFLICT ... DO UPDATE` rather than insert-or-ignore, because the second
 * writer is usually a *correction*: a person overriding a recommendation, or
 * research answering something Brain had proposed. What it must never do is let
 * a weaker answer overwrite a stronger one silently, so the caller decides
 * whether to write at all and `mayReplace` below is the rule it asks.
 */
export async function recordCardFact(input: NewCardFact): Promise<CashCardFact> {
  const at = nowIso();
  await getDb().run(
    `INSERT INTO cash_card_facts
       (id, project_id, opportunity_id, field, kind, value, claim_id, need_id,
        basis, assumptions, uncertainty, decided_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (opportunity_id, field) DO UPDATE SET
       kind = excluded.kind,
       value = excluded.value,
       claim_id = excluded.claim_id,
       need_id = excluded.need_id,
       basis = excluded.basis,
       assumptions = excluded.assumptions,
       uncertainty = excluded.uncertainty,
       decided_by = excluded.decided_by,
       updated_at = excluded.updated_at`,
    [
      newId('ccf'),
      input.projectId,
      input.opportunityId,
      input.field,
      input.kind,
      input.value,
      input.claimId ?? null,
      input.needId ?? null,
      input.basis ?? null,
      input.assumptions ?? null,
      input.uncertainty ?? null,
      input.decidedBy,
      at,
      at,
    ],
  );
  const found = await cardFact(input.opportunityId, input.field);
  if (!found) throw new Error('The card fact disappeared immediately after being written.');
  return found;
}

export async function cardFact(
  opportunityId: string,
  field: string,
): Promise<CashCardFact | null> {
  const rows = await getDb().all<CashCardFactRow>(
    'SELECT * FROM cash_card_facts WHERE opportunity_id = ? AND field = ?',
    [opportunityId, field],
  );
  return rows[0] ? mapFact(rows[0]) : null;
}

export async function cardFactsFor(opportunityId: string): Promise<CashCardFact[]> {
  const rows = await getDb().all<CashCardFactRow>(
    'SELECT * FROM cash_card_facts WHERE opportunity_id = ? ORDER BY field',
    [opportunityId],
  );
  return rows.map(mapFact);
}

export async function cardFactsForProject(projectId: string): Promise<CashCardFact[]> {
  const rows = await getDb().all<CashCardFactRow>(
    'SELECT * FROM cash_card_facts WHERE project_id = ? ORDER BY opportunity_id, field',
    [projectId],
  );
  return rows.map(mapFact);
}

/**
 * May an answer of this kind replace what is there?
 *
 * The order is PERSON, then EVIDENCE, then RECOMMENDATION, and it is about
 * *authority* rather than recency. A person's decision is never overwritten by
 * anything automatic — the whole point of letting them change a recommendation
 * is that it stays changed. A published source outranks Brain's proposal,
 * because the proposal existed to stand in for one. And a recommendation never
 * replaces a recommendation, so a tick cannot churn the card by re-deriving the
 * same thing with a different sentence every pass.
 *
 * It takes the *kind* rather than the row, so the monetization ledger's own
 * facts go through this one function too. There are two fact tables because a
 * path is not an opportunity — thirty paths on one opening would collide on
 * every field — and there is exactly one authority order, because a second copy
 * of it is the two-readers-disagreeing defect this repository keeps correcting.
 */
export function mayReplace(
  existing: { kind: CashCardFact['kind'] } | null,
  incoming: CashCardFact['kind'],
): boolean {
  if (!existing) return true;
  if (existing.kind === 'PERSON') return false;
  if (existing.kind === 'EVIDENCE') return incoming === 'PERSON';
  return incoming === 'PERSON' || incoming === 'EVIDENCE';
}
