/**
 * What a direct model call is allowed to cost, and the ledger that enforces it.
 *
 * The design is one sentence: **a reservation is a compare-and-swap on a
 * ledger row whose CHECK constraint makes over-spending impossible.** Two
 * callers may both read a total with room in it and both try to commit; the
 * `UPDATE` says `WHERE generation = ?`, so exactly one matches, and the
 * database refuses the arithmetic outright even if the guard were removed.
 *
 * That is the third time this codebase has needed the same primitive — the
 * queue's `lease_generation`, the fleet's `fire_generation`, and now this — and
 * it is the same reason each time: the claimant does not supply the value it is
 * compared against.
 *
 * Four rules that are easy to get wrong and are all decided here:
 *
 * **Nothing is authorized by default.** `spendDecision` refuses with a named
 * reason when there is no authorization, when it is disabled, when its ceiling
 * is zero, when it has not taken effect, when it has expired, when the model is
 * not in its list, or when the model's price is unknown. There is no path that
 * treats a missing row as permission.
 *
 * **The worst case is reserved, not the expected case.** The maximum billable
 * input and the model's maximum output, at the pricing version in force. An
 * expected-value reservation lets concurrent calls collectively exceed a
 * ceiling that each of them individually respected.
 *
 * **A price that is not known fails closed.** Never a guess, never a default,
 * never the last price seen. An under-reservation is money spent outside the
 * ceiling, which is precisely what the ceiling exists to prevent.
 *
 * **An unknown outcome keeps its hold.** Step 6's rule: a timeout is not
 * evidence, and neither is a connection reset from a provider that may already
 * have done the work. `markUnknown` records it and leaves the money committed
 * until something authoritative settles it.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso, parseJson, toJson } from './util.ts';

export type SpendPeriod = 'DAY' | 'MONTH' | 'TOTAL';
export type ReservationState = 'HELD' | 'SETTLED' | 'RELEASED' | 'UNKNOWN';
export type ModelLane = 'FAST' | 'DEEP';

export interface LlmModel {
  id: string;
  provider: string;
  modelId: string;
  label: string;
  lane: ModelLane;
  inputMicrosPerMTok: number;
  outputMicrosPerMTok: number;
  pricingVersion: string;
  pricingAsOf: string;
  maxOutputTokens: number;
  contextTokens: number;
  enabled: boolean;
}

interface ModelRow {
  id: string;
  provider: string;
  model_id: string;
  label: string;
  lane: string;
  input_micros_per_mtok: number;
  output_micros_per_mtok: number;
  pricing_version: string;
  pricing_as_of: string;
  max_output_tokens: number;
  context_tokens: number;
  enabled: number;
}

function mapModel(row: ModelRow): LlmModel {
  return {
    id: row.id,
    provider: row.provider,
    modelId: row.model_id,
    label: row.label,
    lane: row.lane as ModelLane,
    inputMicrosPerMTok: Number(row.input_micros_per_mtok),
    outputMicrosPerMTok: Number(row.output_micros_per_mtok),
    pricingVersion: row.pricing_version,
    pricingAsOf: row.pricing_as_of,
    maxOutputTokens: Number(row.max_output_tokens),
    contextTokens: Number(row.context_tokens),
    enabled: Number(row.enabled) === 1,
  };
}

export async function registerModel(input: {
  provider: string;
  modelId: string;
  label: string;
  lane: ModelLane;
  inputMicrosPerMTok: number;
  outputMicrosPerMTok: number;
  pricingVersion: string;
  pricingAsOf: string;
  maxOutputTokens: number;
  contextTokens: number;
  enabled?: boolean;
}): Promise<LlmModel> {
  const id = newId('mdl');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO llm_models
       (id, provider, model_id, label, lane, input_micros_per_mtok, output_micros_per_mtok,
        pricing_version, pricing_as_of, max_output_tokens, context_tokens, enabled,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (provider, model_id, pricing_version) DO NOTHING`,
    [
      id,
      input.provider,
      input.modelId,
      input.label,
      input.lane,
      Math.round(input.inputMicrosPerMTok),
      Math.round(input.outputMicrosPerMTok),
      input.pricingVersion,
      input.pricingAsOf,
      input.maxOutputTokens,
      input.contextTokens,
      input.enabled ? 1 : 0,
      at,
      at,
    ],
  );
  const rows = await getDb().all<ModelRow>(
    'SELECT * FROM llm_models WHERE provider = ? AND model_id = ? AND pricing_version = ?',
    [input.provider, input.modelId, input.pricingVersion],
  );
  if (!rows[0]) throw new Error('The model disappeared immediately after being written.');
  return mapModel(rows[0]);
}

export async function getModel(id: string): Promise<LlmModel | null> {
  const rows = await getDb().all<ModelRow>('SELECT * FROM llm_models WHERE id = ?', [id]);
  return rows[0] ? mapModel(rows[0]) : null;
}

/**
 * The models a lane could use.
 *
 * Ordered by price rather than by name, so a router that takes the first has
 * taken the cheapest — but the router is what decides, and there is no default
 * model anywhere in this file.
 */
export async function listModels(options: { lane?: ModelLane; enabledOnly?: boolean } = {}): Promise<
  LlmModel[]
> {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (options.lane) {
    clauses.push('lane = ?');
    params.push(options.lane);
  }
  if (options.enabledOnly) clauses.push('enabled = 1');
  const rows = await getDb().all<ModelRow>(
    `SELECT * FROM llm_models ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY output_micros_per_mtok, input_micros_per_mtok, model_id`,
    params,
  );
  return rows.map(mapModel);
}

export async function setModelEnabled(id: string, enabled: boolean): Promise<boolean> {
  const result = await getDb().run('UPDATE llm_models SET enabled = ?, updated_at = ? WHERE id = ?', [
    enabled ? 1 : 0,
    nowIso(),
    id,
  ]);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Authorizations
// ---------------------------------------------------------------------------

export interface SpendAuthorization {
  id: string;
  ownerUserId: string;
  provider: string;
  allowedModelIds: string[];
  ceilingMicros: number;
  period: SpendPeriod;
  effectiveFrom: string;
  effectiveUntil: string | null;
  enabled: boolean;
  actorUserId: string | null;
  reason: string;
}

interface AuthorizationRow {
  id: string;
  owner_user_id: string;
  provider: string;
  allowed_model_ids: string;
  ceiling_micros: number;
  period: string;
  effective_from: string;
  effective_until: string | null;
  enabled: number;
  actor_user_id: string | null;
  reason: string;
}

function mapAuthorization(row: AuthorizationRow): SpendAuthorization {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    provider: row.provider,
    allowedModelIds: parseJson<string[]>(row.allowed_model_ids, []),
    ceilingMicros: Number(row.ceiling_micros),
    period: row.period as SpendPeriod,
    effectiveFrom: row.effective_from,
    effectiveUntil: row.effective_until,
    enabled: Number(row.enabled) === 1,
    actorUserId: row.actor_user_id,
    reason: row.reason,
  };
}

/**
 * Create an authorization.
 *
 * Deliberately verbose. Every field here is one a person has to decide, and a
 * convenience overload that filled some of them in is how a ceiling ends up
 * being whatever the last caller happened to pass.
 */
export async function createAuthorization(input: {
  ownerUserId: string;
  provider: string;
  allowedModelIds: string[];
  ceilingMicros: number;
  period: SpendPeriod;
  effectiveFrom: string;
  effectiveUntil?: string | null;
  enabled: boolean;
  actorUserId: string | null;
  reason: string;
}): Promise<SpendAuthorization> {
  const id = newId('spa');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO spend_authorizations
       (id, owner_user_id, provider, allowed_model_ids, ceiling_micros, period,
        effective_from, effective_until, enabled, actor_user_id, reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.ownerUserId,
      input.provider,
      toJson(input.allowedModelIds),
      Math.max(0, Math.round(input.ceilingMicros)),
      input.period,
      input.effectiveFrom,
      input.effectiveUntil ?? null,
      input.enabled ? 1 : 0,
      input.actorUserId,
      input.reason,
      at,
      at,
    ],
  );
  return (await getAuthorization(id))!;
}

export async function getAuthorization(id: string): Promise<SpendAuthorization | null> {
  const rows = await getDb().all<AuthorizationRow>(
    'SELECT * FROM spend_authorizations WHERE id = ?',
    [id],
  );
  return rows[0] ? mapAuthorization(rows[0]) : null;
}

export async function authorizationsFor(
  ownerUserId: string,
  provider: string,
): Promise<SpendAuthorization[]> {
  const rows = await getDb().all<AuthorizationRow>(
    `SELECT * FROM spend_authorizations
      WHERE owner_user_id = ? AND provider = ?
      ORDER BY created_at DESC`,
    [ownerUserId, provider],
  );
  return rows.map(mapAuthorization);
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

/** Which bucket a moment falls in, for an authorization's period. */
export function periodKeyFor(period: SpendPeriod, at: string): string {
  if (period === 'TOTAL') return 'TOTAL';
  if (period === 'MONTH') return at.slice(0, 7);
  return at.slice(0, 10);
}

export interface LedgerRow {
  id: string;
  authorizationId: string;
  periodKey: string;
  ceilingMicros: number;
  heldMicros: number;
  settledMicros: number;
  generation: number;
}

interface RawLedgerRow {
  id: string;
  authorization_id: string;
  period_key: string;
  ceiling_micros: number;
  held_micros: number;
  settled_micros: number;
  generation: number;
}

function mapLedger(row: RawLedgerRow): LedgerRow {
  return {
    id: row.id,
    authorizationId: row.authorization_id,
    periodKey: row.period_key,
    ceilingMicros: Number(row.ceiling_micros),
    heldMicros: Number(row.held_micros),
    settledMicros: Number(row.settled_micros),
    generation: Number(row.generation),
  };
}

/**
 * The ledger row for one authorization and period, created if it does not
 * exist.
 *
 * The ceiling is *copied* at creation. A person who lowers an authorization
 * tomorrow has not thereby made today's committed spending over budget, and a
 * person who raises it does not retroactively widen a period that has closed.
 */
export async function ledgerFor(
  authorization: SpendAuthorization,
  at: string,
): Promise<LedgerRow> {
  const periodKey = periodKeyFor(authorization.period, at);
  const existing = await getDb().all<RawLedgerRow>(
    'SELECT * FROM spend_ledger WHERE authorization_id = ? AND period_key = ?',
    [authorization.id, periodKey],
  );
  if (existing[0]) return mapLedger(existing[0]);

  await getDb().run(
    `INSERT INTO spend_ledger
       (id, authorization_id, period_key, ceiling_micros, held_micros, settled_micros,
        generation, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?)
     ON CONFLICT (authorization_id, period_key) DO NOTHING`,
    [newId('sld'), authorization.id, periodKey, authorization.ceilingMicros, at, at],
  );
  const rows = await getDb().all<RawLedgerRow>(
    'SELECT * FROM spend_ledger WHERE authorization_id = ? AND period_key = ?',
    [authorization.id, periodKey],
  );
  if (!rows[0]) throw new Error('The ledger row disappeared immediately after being written.');
  return mapLedger(rows[0]);
}

export interface Reservation {
  id: string;
  authorizationId: string;
  ledgerId: string;
  ownerUserId: string;
  modelRowId: string;
  reservedMicros: number;
  state: ReservationState;
  actualMicros: number | null;
  outcomeReason: string | null;
  idempotencyKey: string;
}

interface RawReservationRow {
  id: string;
  authorization_id: string;
  ledger_id: string;
  owner_user_id: string;
  model_row_id: string;
  reserved_micros: number;
  state: string;
  actual_micros: number | null;
  outcome_reason: string | null;
  idempotency_key: string;
}

function mapReservation(row: RawReservationRow): Reservation {
  return {
    id: row.id,
    authorizationId: row.authorization_id,
    ledgerId: row.ledger_id,
    ownerUserId: row.owner_user_id,
    modelRowId: row.model_row_id,
    reservedMicros: Number(row.reserved_micros),
    state: row.state as ReservationState,
    actualMicros: row.actual_micros === null ? null : Number(row.actual_micros),
    outcomeReason: row.outcome_reason,
    idempotencyKey: row.idempotency_key,
  };
}

export async function getReservation(id: string): Promise<Reservation | null> {
  const rows = await getDb().all<RawReservationRow>(
    'SELECT * FROM spend_reservations WHERE id = ?',
    [id],
  );
  return rows[0] ? mapReservation(rows[0]) : null;
}

export async function reservationByKey(key: string): Promise<Reservation | null> {
  const rows = await getDb().all<RawReservationRow>(
    'SELECT * FROM spend_reservations WHERE idempotency_key = ?',
    [key],
  );
  return rows[0] ? mapReservation(rows[0]) : null;
}

/** The exact micro-dollars a call could cost at worst. Integers throughout. */
export function worstCaseMicros(input: {
  model: LlmModel;
  maxInputTokens: number;
  maxOutputTokens: number;
}): number {
  const inputs = Math.ceil((input.maxInputTokens * input.model.inputMicrosPerMTok) / 1_000_000);
  const outputs = Math.ceil((input.maxOutputTokens * input.model.outputMicrosPerMTok) / 1_000_000);
  return inputs + outputs;
}

export type ReserveOutcome =
  | { ok: true; reservation: Reservation; replayed: boolean }
  | { ok: false; reason: string; remainingMicros: number };

/**
 * Commit the worst case, or refuse.
 *
 * One guarded `UPDATE` carries the whole proof: the ledger row, the generation
 * it was read at, and the arithmetic. A loser retries against the new
 * generation a bounded number of times and is then refused — an ordinary
 * outcome under contention, not an error.
 */
export async function reserve(input: {
  authorization: SpendAuthorization;
  model: LlmModel;
  ownerUserId: string;
  projectId?: string | null;
  conversationId?: string | null;
  maxInputTokens: number;
  maxOutputTokens: number;
  idempotencyKey: string;
  at?: string;
}): Promise<ReserveOutcome> {
  const at = input.at ?? nowIso();

  // A retried attempt reserves once. Step 6's rule, and the reason the key is
  // derived from the turn rather than from the attempt.
  const already = await reservationByKey(input.idempotencyKey);
  if (already) return { ok: true, reservation: already, replayed: true };

  const micros = worstCaseMicros({
    model: input.model,
    maxInputTokens: input.maxInputTokens,
    maxOutputTokens: input.maxOutputTokens,
  });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const ledger = await ledgerFor(input.authorization, at);
    if (ledger.heldMicros + ledger.settledMicros + micros > ledger.ceilingMicros) {
      return {
        ok: false,
        reason: 'this would go past the ceiling somebody set for this period',
        remainingMicros: Math.max(
          0,
          ledger.ceilingMicros - ledger.heldMicros - ledger.settledMicros,
        ),
      };
    }
    const claimed = await getDb().run(
      `UPDATE spend_ledger
          SET held_micros = held_micros + ?, generation = generation + 1, updated_at = ?
        WHERE id = ?
          AND generation = ?
          AND held_micros + settled_micros + ? <= ceiling_micros`,
      [micros, at, ledger.id, ledger.generation, micros],
    );
    if (claimed.changes === 0) continue;

    const id = newId('srv');
    await getDb().run(
      `INSERT INTO spend_reservations
         (id, authorization_id, ledger_id, owner_user_id, project_id, conversation_id,
          model_row_id, input_micros_per_mtok, output_micros_per_mtok, pricing_version,
          max_input_tokens, max_output_tokens, reserved_micros, state, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'HELD', ?, ?)`,
      [
        id,
        input.authorization.id,
        ledger.id,
        input.ownerUserId,
        input.projectId ?? null,
        input.conversationId ?? null,
        input.model.id,
        input.model.inputMicrosPerMTok,
        input.model.outputMicrosPerMTok,
        input.model.pricingVersion,
        input.maxInputTokens,
        input.maxOutputTokens,
        micros,
        input.idempotencyKey,
        at,
      ],
    );
    return { ok: true, reservation: (await getReservation(id))!, replayed: false };
  }
  return { ok: false, reason: 'the ledger was too busy to commit against', remainingMicros: 0 };
}

/**
 * Settle a reservation from the provider's own usage report.
 *
 * A compare-and-swap on the reservation's state, so a duplicated callback
 * settles once. The actual cost is capped at what was reserved: a provider
 * reporting more than the worst case is a fact worth recording and is not a
 * licence to exceed a ceiling that was already committed against.
 */
export async function settle(input: {
  reservationId: string;
  inputTokens: number;
  outputTokens: number;
  at?: string;
}): Promise<{ ok: boolean; actualMicros: number }> {
  const at = input.at ?? nowIso();
  const reservation = await getReservation(input.reservationId);
  if (!reservation || reservation.state !== 'HELD') return { ok: false, actualMicros: 0 };

  const rows = await getDb().all<{
    input_micros_per_mtok: number;
    output_micros_per_mtok: number;
  }>(
    'SELECT input_micros_per_mtok, output_micros_per_mtok FROM spend_reservations WHERE id = ?',
    [reservation.id],
  );
  const price = rows[0]!;
  const raw =
    Math.ceil((input.inputTokens * Number(price.input_micros_per_mtok)) / 1_000_000) +
    Math.ceil((input.outputTokens * Number(price.output_micros_per_mtok)) / 1_000_000);
  const actual = Math.min(raw, reservation.reservedMicros);

  const claimed = await getDb().run(
    `UPDATE spend_reservations
        SET state = 'SETTLED', actual_input_tokens = ?, actual_output_tokens = ?,
            actual_micros = ?, settled_at = ?
      WHERE id = ? AND state = 'HELD'`,
    [input.inputTokens, input.outputTokens, actual, at, reservation.id],
  );
  if (claimed.changes === 0) return { ok: false, actualMicros: 0 };

  await getDb().run(
    `UPDATE spend_ledger
        SET held_micros = held_micros - ?, settled_micros = settled_micros + ?,
            generation = generation + 1, updated_at = ?
      WHERE id = ?`,
    [reservation.reservedMicros, actual, at, reservation.ledgerId],
  );
  return { ok: true, actualMicros: actual };
}

/**
 * Release a hold, for a call that provably never reached the provider.
 *
 * "Provably" is the whole word. A refused request, a validation failure before
 * the socket opened, a model the adapter would not accept — those are safe. A
 * timeout is not one of them.
 */
export async function release(input: {
  reservationId: string;
  reason: string;
  at?: string;
}): Promise<boolean> {
  const at = input.at ?? nowIso();
  const reservation = await getReservation(input.reservationId);
  if (!reservation || reservation.state !== 'HELD') return false;
  const claimed = await getDb().run(
    `UPDATE spend_reservations
        SET state = 'RELEASED', outcome_reason = ?, settled_at = ?
      WHERE id = ? AND state = 'HELD'`,
    [input.reason, at, reservation.id],
  );
  if (claimed.changes === 0) return false;
  await getDb().run(
    `UPDATE spend_ledger
        SET held_micros = held_micros - ?, generation = generation + 1, updated_at = ?
      WHERE id = ?`,
    [reservation.reservedMicros, at, reservation.ledgerId],
  );
  return true;
}

/**
 * Record that the outcome is not known, and keep the money committed.
 *
 * Step 6, at a different altitude. A timeout, a reset, or an error from a
 * provider that had already accepted the work are all consistent with the call
 * having happened and cost money. The honest ledger entry is the conservative
 * one, and a person settles it against a bill.
 */
export async function markUnknown(input: {
  reservationId: string;
  reason: string;
  at?: string;
}): Promise<boolean> {
  const result = await getDb().run(
    `UPDATE spend_reservations
        SET state = 'UNKNOWN', outcome_reason = ?, settled_at = ?
      WHERE id = ? AND state = 'HELD'`,
    [input.reason, input.at ?? nowIso(), input.reservationId],
  );
  // The ledger is deliberately not touched. The hold stays.
  return result.changes > 0;
}

/** What is left, for a screen that shows a person their remaining budget. */
export async function remainingFor(
  authorization: SpendAuthorization,
  at: string,
): Promise<{ ceilingMicros: number; heldMicros: number; settledMicros: number; remainingMicros: number }> {
  const ledger = await ledgerFor(authorization, at);
  return {
    ceilingMicros: ledger.ceilingMicros,
    heldMicros: ledger.heldMicros,
    settledMicros: ledger.settledMicros,
    remainingMicros: Math.max(0, ledger.ceilingMicros - ledger.heldMicros - ledger.settledMicros),
  };
}
