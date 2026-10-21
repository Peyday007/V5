/**
 * The commerce kernel's rows (§73): the programme a person started, the
 * products on the map, the facts gated claims established about them, and the
 * kernel's own questions.
 *
 * Every write is idempotent by a unique index rather than by a read, for the
 * reason every other repository here is: the tick runs on more than one
 * instance, both halves of a check-then-write can read "there is no row", and
 * the arbiter has to be the database. A loser reads back the winner's row.
 *
 * Nothing here derives anything. There is no margin, no maturity and no rank
 * in this file — `services/commerce/` reads those from these rows and stores
 * none of them.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import { productKey } from '../domain/commerce.ts';
import type {
  CommerceFact,
  CommerceFactRow,
  CommerceFinding,
  CommerceOrigin,
  CommerceProduct,
  CommerceProductRow,
  CommerceProgramme,
  CommerceProgrammeRow,
  CommerceProgrammeState,
  CommerceRound,
  CommerceRoundPurpose,
  CommerceRoundRow,
  CommerceRoundState,
} from '../domain/types.ts';

/* --------------------------------------------------------------------------
 * The programme
 * ------------------------------------------------------------------------ */

function mapProgramme(row: CommerceProgrammeRow): CommerceProgramme {
  return {
    id: row.id,
    projectId: row.project_id,
    objective: row.objective,
    state: row.state as CommerceProgrammeState,
    startedBy: row.started_by,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  };
}

export async function getCommerceProgramme(projectId: string): Promise<CommerceProgramme | null> {
  const row = await getDb().get<CommerceProgrammeRow>(
    'SELECT * FROM commerce_programmes WHERE project_id = ?',
    [projectId],
  );
  return row ? mapProgramme(row) : null;
}

/**
 * Start the programme, or find the one already started.
 *
 * Idempotent by the project: starting twice is one programme, and the second
 * call is told it already existed rather than writing over the first person's
 * objective.
 */
export async function insertCommerceProgramme(input: {
  projectId: string;
  objective: string;
  startedBy: string;
}): Promise<{ programme: CommerceProgramme; created: boolean }> {
  const id = newId('cmp');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO commerce_programmes
       (id, project_id, objective, state, started_by, started_at, updated_at)
     VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [id, input.projectId, input.objective, input.startedBy, at, at],
  );
  const programme = await getCommerceProgramme(input.projectId);
  if (!programme) throw new Error('The commerce programme disappeared immediately after being written.');
  return { programme, created: programme.id === id };
}

/** Move the programme between states, guarded on the state it is moving from. */
export async function setCommerceProgrammeState(input: {
  projectId: string;
  from: CommerceProgrammeState;
  to: CommerceProgrammeState;
}): Promise<boolean> {
  const result = await getDb().run(
    'UPDATE commerce_programmes SET state = ?, updated_at = ? WHERE project_id = ? AND state = ?',
    [input.to, nowIso(), input.projectId, input.from],
  );
  return result.changes > 0;
}

/* --------------------------------------------------------------------------
 * The products
 * ------------------------------------------------------------------------ */

function mapProduct(row: CommerceProductRow): CommerceProduct {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    productKey: row.product_key,
    note: row.note,
    origin: row.origin as CommerceOrigin,
    sourceClaimId: row.source_claim_id,
    retiredAt: row.retired_at,
    retiredReason: row.retired_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Put a product on the map, or find the one already there.
 *
 * The identity is (project, key), so two workers naming one product write one
 * row and the first spelling seen is the one shown. `created` is decided by
 * comparing the id back, because the two backends report a conflicted insert
 * differently.
 */
export async function createCommerceProduct(input: {
  projectId: string;
  name: string;
  note?: string | null;
  origin: CommerceOrigin;
  sourceClaimId?: string | null;
}): Promise<{ product: CommerceProduct; created: boolean }> {
  const name = input.name.replace(/\s+/g, ' ').trim();
  if (!name) throw new Error('A product must have a name.');
  if (input.origin !== 'SEED' && !input.sourceClaimId) {
    throw new Error('Only a seeded product may exist without the claim that established it.');
  }
  const key = productKey(name);
  const id = newId('cpr');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO commerce_products
       (id, project_id, name, product_key, note, origin, source_claim_id,
        retired_at, retired_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
     ON CONFLICT DO NOTHING`,
    [id, input.projectId, name, key, input.note ?? null, input.origin, input.sourceClaimId ?? null, at, at],
  );
  const row = await getDb().get<CommerceProductRow>(
    'SELECT * FROM commerce_products WHERE project_id = ? AND product_key = ?',
    [input.projectId, key],
  );
  if (!row) throw new Error('The product disappeared immediately after being written.');
  return { product: mapProduct(row), created: row.id === id };
}

export async function listCommerceProducts(projectId: string): Promise<CommerceProduct[]> {
  const rows = await getDb().all<CommerceProductRow>(
    'SELECT * FROM commerce_products WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapProduct);
}

/** Retire a product, keeping its row and its facts. Guarded on it being live. */
export async function retireCommerceProduct(input: {
  projectId: string;
  productId: string;
  reason: string;
}): Promise<boolean> {
  const at = nowIso();
  const result = await getDb().run(
    `UPDATE commerce_products SET retired_at = ?, retired_reason = ?, updated_at = ?
      WHERE id = ? AND project_id = ? AND retired_at IS NULL`,
    [at, input.reason, at, input.productId, input.projectId],
  );
  return result.changes > 0;
}

/* --------------------------------------------------------------------------
 * The facts
 * ------------------------------------------------------------------------ */

function mapFact(row: CommerceFactRow): CommerceFact {
  return {
    id: row.id,
    projectId: row.project_id,
    productId: row.product_id,
    finding: row.finding as CommerceFinding,
    subject: row.subject,
    value: row.value,
    amountCents: row.amount_cents === null ? null : Number(row.amount_cents),
    rateBps: row.rate_bps === null ? null : Number(row.rate_bps),
    currency: row.currency,
    days: row.days === null ? null : Number(row.days),
    statement: row.statement,
    publisher: row.publisher,
    observedOn: row.observed_on,
    sourceClaimId: row.source_claim_id,
    createdAt: row.created_at,
  };
}

/**
 * One gated claim into one fact. Idempotent by the claim, so a re-read of the
 * same round writes nothing and reports that the row already existed.
 */
export async function recordCommerceFact(input: {
  projectId: string;
  productId: string;
  finding: CommerceFinding;
  subject: string;
  value: string | null;
  amountCents: number | null;
  rateBps: number | null;
  currency: string | null;
  days: number | null;
  statement: string;
  publisher: string | null;
  observedOn: string | null;
  sourceClaimId: string;
}): Promise<{ fact: CommerceFact; created: boolean }> {
  const id = newId('cfa');
  await getDb().run(
    `INSERT INTO commerce_facts
       (id, project_id, product_id, finding, subject, value, amount_cents, rate_bps,
        currency, days, statement, publisher, observed_on, source_claim_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.productId,
      input.finding,
      input.subject,
      input.value,
      input.amountCents,
      input.rateBps,
      input.currency,
      input.days,
      input.statement,
      input.publisher,
      input.observedOn,
      input.sourceClaimId,
      nowIso(),
    ],
  );
  const row = await getDb().get<CommerceFactRow>(
    'SELECT * FROM commerce_facts WHERE source_claim_id = ?',
    [input.sourceClaimId],
  );
  if (!row) throw new Error('The fact disappeared immediately after being written.');
  return { fact: mapFact(row), created: row.id === id };
}

export async function listCommerceFacts(projectId: string): Promise<CommerceFact[]> {
  const rows = await getDb().all<CommerceFactRow>(
    'SELECT * FROM commerce_facts WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapFact);
}

/* --------------------------------------------------------------------------
 * The kernel's own questions
 * ------------------------------------------------------------------------ */

function mapRound(row: CommerceRoundRow): CommerceRound {
  return {
    id: row.id,
    projectId: row.project_id,
    cashModeId: row.cash_mode_id,
    purpose: row.purpose as CommerceRoundPurpose,
    productKey: row.product_key,
    candidateId: row.candidate_id,
    round: Number(row.round),
    state: row.state as CommerceRoundState,
    found: row.found === null ? null : Number(row.found),
    createdAt: row.created_at,
    settledAt: row.settled_at,
  };
}

export async function openCommerceRound(input: {
  projectId: string;
  cashModeId: string;
  purpose: CommerceRoundPurpose;
  productKey: string | null;
  candidateId: string;
  round: number;
}): Promise<{ round: CommerceRound; created: boolean }> {
  const id = newId('cmq');
  await getDb().run(
    `INSERT INTO commerce_rounds
       (id, project_id, cash_mode_id, purpose, product_key, candidate_id, round,
        state, found, created_at, settled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', NULL, ?, NULL)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.cashModeId,
      input.purpose,
      input.productKey,
      input.candidateId,
      input.round,
      nowIso(),
    ],
  );
  /*
   * Read back by the natural key, building the nullity clause rather than
   * parameterising it: `? IS NULL` has no type Postgres can infer (§47).
   */
  const where = ['project_id = ?', 'purpose = ?', 'round = ?'];
  const values: (string | number)[] = [input.projectId, input.purpose, input.round];
  if (input.productKey === null) where.push('product_key IS NULL');
  else {
    where.push('product_key = ?');
    values.push(input.productKey);
  }
  const row = await getDb().get<CommerceRoundRow>(
    `SELECT * FROM commerce_rounds WHERE ${where.join(' AND ')}`,
    values,
  );
  if (!row) throw new Error('The round disappeared immediately after being written.');
  return { round: mapRound(row), created: row.id === id };
}

/** Close a round with what it established. Guarded on it still being OPEN. */
export async function settleCommerceRound(input: {
  roundId: string;
  found: number;
  to: 'SETTLED' | 'ABANDONED';
}): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE commerce_rounds SET state = ?, found = ?, settled_at = ?
      WHERE id = ? AND state = 'OPEN'`,
    [input.to, input.found, nowIso(), input.roundId],
  );
  return result.changes > 0;
}

export async function listCommerceRounds(projectId: string): Promise<CommerceRound[]> {
  const rows = await getDb().all<CommerceRoundRow>(
    'SELECT * FROM commerce_rounds WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapRound);
}

/** The live rounds, keyed by the candidate that asks each one. */
export async function openCommerceRoundsByCandidate(
  projectId: string,
): Promise<Map<string, CommerceRound>> {
  const rows = await getDb().all<CommerceRoundRow>(
    "SELECT * FROM commerce_rounds WHERE project_id = ? AND state = 'OPEN'",
    [projectId],
  );
  const out = new Map<string, CommerceRound>();
  for (const row of rows) out.set(row.candidate_id, mapRound(row));
  return out;
}

/** Which kernel question this candidate is asking, if any. Read by the compiler. */
export async function commerceRoundForCandidate(candidateId: string): Promise<CommerceRound | null> {
  const row = await getDb().get<CommerceRoundRow>(
    'SELECT * FROM commerce_rounds WHERE candidate_id = ?',
    [candidateId],
  );
  return row ? mapRound(row) : null;
}
