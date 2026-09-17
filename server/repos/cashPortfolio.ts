/**
 * The portfolio: opportunities, and the needs they raise.
 *
 * The record here is the plan's own common transaction record, linked to what
 * Brain already holds rather than duplicating it — `candidate_id` is the
 * Russell idea whose discovery produced this, `external_record_id` is the
 * connected site's row when one is involved. Nothing here reimplements
 * sourcing, diagnostics, a relationship history or a sales workflow: those live
 * in the connected system and reach Brain as evidence.
 *
 * **Every card field is nullable and the blank means unknown.** `readyToTest`
 * in `services/cash/card.ts` refuses an opportunity with an unknown in a
 * load-bearing position; what must never happen is a blank being read as a
 * favourable assumption, which is why there are no defaults on any of them.
 */
import { getDb } from '../db/database.ts';
import type { SqlParam } from '../db/types.ts';
import { buildUpdate, newId, nowIso, parseJson, toJson } from './util.ts';
import {
  OPPORTUNITY_VALIDATION_STATES,
  type OpportunityValidationState,
} from '../domain/types.ts';

/** Reading a stored value back into the closed set, or null. */
function isValidationState(value: unknown): value is OpportunityValidationState {
  return (
    typeof value === 'string' &&
    (OPPORTUNITY_VALIDATION_STATES as readonly string[]).includes(value)
  );
}
import type {
  CashMechanism,
  CashNeed,
  CashNeedRow,
  CashNeedState,
  CashOpportunity,
  CashOpportunityRow,
  CashOpportunityState,
} from '../domain/types.ts';

export function portfolioNow(): string {
  return nowIso();
}

function mapOpportunity(row: CashOpportunityRow): CashOpportunity {
  return {
    id: row.id,
    projectId: row.project_id,
    cashModeId: row.cash_mode_id,
    ownerUserId: row.owner_user_id,
    title: row.title,
    mechanism: row.mechanism as CashMechanism,
    industry: row.industry,
    source: row.source,
    candidateId: row.candidate_id,
    externalRecordId: row.external_record_id,
    sourceClaimId: row.source_claim_id,
    discoveredByCandidateId: row.discovered_by_candidate_id,
    orchestrationId: row.orchestration_id ?? null,
    fragmentId: row.fragment_id ?? null,
    discoveryRoundId: row.discovery_round_id ?? null,
    validationOrchestrationId: row.validation_orchestration_id ?? null,
    validationState: isValidationState(row.validation_state) ? row.validation_state : null,
    validationStartedAt: row.validation_started_at ?? null,
    validationSettledAt: row.validation_settled_at ?? null,
    payer: row.payer,
    reachableChannel: row.reachable_channel,
    buyingSignal: row.buying_signal,
    signalObservedAt: row.signal_observed_at,
    offerScope: row.offer_scope,
    acceptanceCondition: row.acceptance_condition,
    priceCents: row.price_cents,
    currency: row.currency,
    paymentTerms: row.payment_terms,
    fulfillmentOwner: row.fulfillment_owner,
    deliveryMethod: row.delivery_method,
    requiredInputs: row.required_inputs,
    deadline: row.deadline,
    economicsNote: row.economics_note,
    peakFundingCents: row.peak_funding_cents,
    humanHours: row.human_hours,
    expiresAt: row.expires_at,
    expiryReason: row.expiry_reason,
    dependsOnId: row.depends_on_id,
    duplicateOfId: row.duplicate_of_id,
    requiredCapabilities: parseJson<string[]>(row.required_capabilities, []),
    executionAsset: row.execution_asset,
    assetRevision: row.asset_revision,
    state: row.state as CashOpportunityState,
    exhaustedAt: row.exhausted_at,
    exhaustedReason: row.exhausted_reason,
    nextAction: row.next_action,
    nextActionDue: row.next_action_due,
    outcome: row.outcome,
    stopRule: row.stop_rule,
    declinedByUserId: row.declined_by_user_id,
    declinedReason: row.declined_reason,
    reofferedFromId: row.reoffered_from_id,
    archivedReason: row.archived_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface NewOpportunity {
  projectId: string;
  cashModeId: string;
  ownerUserId: string;
  title: string;
  mechanism: CashMechanism;
  currency: string;
  industry?: string | null;
  source?: string | null;
  candidateId?: string | null;
  externalRecordId?: string | null;
  sourceClaimId?: string | null;
  discoveredByCandidateId?: string | null;
  /**
   * The whole chain back to the evidence, written here and never inferred.
   *
   * `sourceClaimId` alone resolved to a claim and left "what research
   * established this, under which question, in which round" to be walked
   * backwards through a mission row that an administrator-started packet does
   * not have. These are the rest of it.
   */
  orchestrationId?: string | null;
  fragmentId?: string | null;
  discoveryRoundId?: string | null;
  expiresAt?: string | null;
  expiryReason?: string | null;
  dependsOnId?: string | null;
  duplicateOfId?: string | null;
  requiredCapabilities?: string[];
  executionAsset?: string | null;
  assetRevision?: string | null;
  nextAction?: string | null;
  nextActionDue?: string | null;
  stopRule?: string | null;
  reofferedFromId?: string | null;
}

export async function createOpportunity(input: NewOpportunity): Promise<CashOpportunity> {
  const id = newId('cop');
  const at = portfolioNow();
  await getDb().run(
    `INSERT INTO cash_opportunities
       (id, project_id, cash_mode_id, owner_user_id, title, mechanism, industry, source,
        candidate_id, external_record_id, source_claim_id, discovered_by_candidate_id,
        orchestration_id, fragment_id, discovery_round_id,
        payer, reachable_channel, buying_signal, signal_observed_at,
        offer_scope, acceptance_condition, price_cents, currency, payment_terms,
        fulfillment_owner, delivery_method, required_inputs, deadline, economics_note,
        peak_funding_cents, human_hours, expires_at, expiry_reason,
        depends_on_id, duplicate_of_id, required_capabilities,
        execution_asset, asset_revision, state,
        exhausted_at, exhausted_reason, next_action, next_action_due, outcome, stop_rule,
        declined_by_user_id, declined_reason, reoffered_from_id, archived_reason,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             ?, ?, ?,
             NULL, NULL, NULL, NULL,
             NULL, NULL, NULL, ?, NULL,
             NULL, NULL, NULL, NULL, NULL,
             NULL, NULL, ?, ?,
             ?, ?, ?,
             ?, ?, 'DISCOVERED',
             NULL, NULL, ?, ?, NULL, ?,
             NULL, NULL, ?, NULL,
             ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.cashModeId,
      input.ownerUserId,
      input.title,
      input.mechanism,
      input.industry ?? null,
      input.source ?? null,
      input.candidateId ?? null,
      input.externalRecordId ?? null,
      input.sourceClaimId ?? null,
      input.discoveredByCandidateId ?? null,
      input.orchestrationId ?? null,
      input.fragmentId ?? null,
      input.discoveryRoundId ?? null,
      input.currency,
      input.expiresAt ?? null,
      input.expiryReason ?? null,
      input.dependsOnId ?? null,
      input.duplicateOfId ?? null,
      toJson(input.requiredCapabilities ?? []),
      input.executionAsset ?? null,
      input.assetRevision ?? null,
      input.nextAction ?? null,
      input.nextActionDue ?? null,
      input.stopRule ?? null,
      input.reofferedFromId ?? null,
      at,
      at,
    ],
  );
  const created = await getOpportunity(id);
  if (created) return created;
  /*
   * Lost the race for this claim, which is an ordinary outcome.
   *
   * `idx_cash_opportunities_one_per_claim` is what makes "one opportunity per
   * supported opening" true rather than merely likely: two ticks can both read
   * that a claim has no opportunity yet, and exactly one of their inserts
   * lands. The loser reads back the winner's row, which is the same shape
   * `ensureGoal` and `reserve` take.
   */
  if (input.sourceClaimId) {
    const existing = await opportunityForClaim(input.projectId, input.sourceClaimId);
    if (existing) return existing;
  }
  throw new Error('The opportunity disappeared immediately after being written.');
}

export async function getOpportunity(id: string): Promise<CashOpportunity | null> {
  const rows = await getDb().all<CashOpportunityRow>(
    'SELECT * FROM cash_opportunities WHERE id = ?',
    [id],
  );
  return rows[0] ? mapOpportunity(rows[0]) : null;
}

/**
 * One project's portfolio.
 *
 * Bounded to the project in the *query*, never filtered afterwards in
 * JavaScript: a listing that fetched broadly and filtered later is one
 * forgotten predicate away from showing somebody another person's deals, and
 * the count alone would already be information.
 */
export async function listOpportunities(input: {
  projectId: string;
  states?: CashOpportunityState[];
}): Promise<CashOpportunity[]> {
  if (input.states && input.states.length === 0) return [];
  const where = ['project_id = ?'];
  const params: SqlParam[] = [input.projectId];
  if (input.states) {
    where.push(`state IN (${input.states.map(() => '?').join(', ')})`);
    params.push(...input.states);
  }
  const rows = await getDb().all<CashOpportunityRow>(
    `SELECT * FROM cash_opportunities
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC, id DESC`,
    params,
  );
  return rows.map(mapOpportunity);
}

/** The opportunity harvested from one claim, if that claim produced one. */
export async function opportunityForClaim(
  projectId: string,
  claimId: string,
): Promise<CashOpportunity | null> {
  const rows = await getDb().all<CashOpportunityRow>(
    'SELECT * FROM cash_opportunities WHERE project_id = ? AND source_claim_id = ?',
    [projectId, claimId],
  );
  return rows[0] ? mapOpportunity(rows[0]) : null;
}

/**
 * The opportunities a Russell idea belongs to.
 *
 * Reads `candidate_id` only. `discovered_by_candidate_id` names the broad
 * bucket whose mission found an opening and is research about none of the
 * openings it found, so a reader asking "what is this idea about" must not see
 * it — see the comment on that column in migration 054.
 *
 * Returns every match rather than the newest, because the one caller asks
 * whether *any* of them is an obligation, and a newest-first `SELECT` with no
 * tiebreak on that question is the `binForOrchestration` defect again.
 */
export async function opportunitiesForCandidate(
  candidateId: string,
): Promise<CashOpportunity[]> {
  const rows = await getDb().all<CashOpportunityRow>(
    `SELECT * FROM cash_opportunities WHERE candidate_id = ?
      ORDER BY created_at DESC, id DESC`,
    [candidateId],
  );
  return rows.map(mapOpportunity);
}

/**
 * The opportunity a candidate *is*, in one project.
 *
 * `candidate_id` means "the idea this opportunity is" — Brain researching on
 * this opportunity's own behalf — and is deliberately a different column from
 * `discovered_by_candidate_id`, which is the broad bucket that found it. The
 * compiler reads this to know it is compiling a deep dive rather than a bucket,
 * which is a row rather than a reading of the idea's prose.
 */
export async function opportunityForOwnCandidate(
  projectId: string,
  candidateId: string,
): Promise<CashOpportunity | null> {
  const rows = await getDb().all<CashOpportunityRow>(
    `SELECT * FROM cash_opportunities
      WHERE project_id = ? AND candidate_id = ?
      ORDER BY created_at DESC, id DESC`,
    [projectId, candidateId],
  );
  return rows[0] ? mapOpportunity(rows[0]) : null;
}

/**
 * The evidence card, or any other non-state field.
 *
 * Deliberately cannot write `state`: a lifecycle move is
 * `transitionOpportunity` below, which is guarded on where the row is now. A
 * patch that could set both would let a caller move an opportunity to
 * `COLLECTED` in the same call that filled in its price, with nothing checking
 * the order.
 */
export async function updateOpportunity(
  id: string,
  patch: Partial<{
    title: string;
    industry: string | null;
    source: string | null;
    payer: string | null;
    reachable_channel: string | null;
    buying_signal: string | null;
    signal_observed_at: string | null;
    offer_scope: string | null;
    acceptance_condition: string | null;
    price_cents: number | null;
    payment_terms: string | null;
    fulfillment_owner: string | null;
    delivery_method: string | null;
    required_inputs: string | null;
    deadline: string | null;
    economics_note: string | null;
    peak_funding_cents: number | null;
    human_hours: number | null;
    expires_at: string | null;
    expiry_reason: string | null;
    depends_on_id: string | null;
    duplicate_of_id: string | null;
    required_capabilities: string;
    execution_asset: string | null;
    asset_revision: string | null;
    next_action: string | null;
    next_action_due: string | null;
    outcome: string | null;
    stop_rule: string | null;
    candidate_id: string | null;
    external_record_id: string | null;
    discovered_by_candidate_id: string | null;
    validation_orchestration_id: string | null;
    validation_state: OpportunityValidationState | null;
    validation_started_at: string | null;
    validation_settled_at: string | null;
  }>,
): Promise<CashOpportunity | null> {
  const { clause, values } = buildUpdate(patch);
  if (!clause) return getOpportunity(id);
  await getDb().run(`UPDATE cash_opportunities SET ${clause}, updated_at = ? WHERE id = ?`, [
    ...(values as SqlParam[]),
    portfolioNow(),
    id,
  ]);
  return getOpportunity(id);
}

/**
 * Move one opportunity, guarded on where it is now.
 *
 * Two people pressing the same control produce one transition; the loser is an
 * ordinary outcome. The extra columns a particular move needs — who declined
 * it, why it was archived — are written in the same statement, so there is no
 * state in which the row says `DECLINED` and nothing says by whom.
 */
export async function transitionOpportunity(input: {
  id: string;
  from: CashOpportunityState[];
  to: CashOpportunityState;
  declinedByUserId?: string | null;
  declinedReason?: string | null;
  archivedReason?: string | null;
  outcome?: string | null;
  nextAction?: string | null;
  nextActionDue?: string | null;
}): Promise<boolean> {
  if (input.from.length === 0) return false;
  const at = portfolioNow();
  const sets = ['state = ?', 'updated_at = ?'];
  const params: SqlParam[] = [input.to, at];
  const optional: [string, SqlParam][] = [
    ['declined_by_user_id', input.declinedByUserId],
    ['declined_reason', input.declinedReason],
    ['archived_reason', input.archivedReason],
    ['outcome', input.outcome],
    ['next_action', input.nextAction],
    ['next_action_due', input.nextActionDue],
  ];
  for (const [column, value] of optional) {
    if (value === undefined) continue;
    sets.push(`${column} = ?`);
    params.push(value);
  }
  params.push(input.id, ...input.from);
  const result = await getDb().run(
    `UPDATE cash_opportunities
        SET ${sets.join(', ')}
      WHERE id = ? AND state IN (${input.from.map(() => '?').join(', ')})`,
    params,
  );
  return result.changes === 1;
}

/**
 * The opening is finished, whatever the transaction did.
 *
 * Separate from the state on purpose: a completed profitable one-off is a
 * success and the mechanism being spent is a different fact about the world.
 * Collapsing them would make "we made $3,000 and there is no more of it" read
 * as a failure, which is precisely the reading the plan exists to refuse.
 */
export async function markExhausted(input: {
  id: string;
  reason: string;
}): Promise<boolean> {
  const at = portfolioNow();
  const result = await getDb().run(
    `UPDATE cash_opportunities
        SET exhausted_at = ?, exhausted_reason = ?, updated_at = ?
      WHERE id = ? AND exhausted_at IS NULL`,
    [at, input.reason, at, input.id],
  );
  return result.changes === 1;
}

/* ------------------------------------------------------------------------ */
/* Needs                                                                     */
/* ------------------------------------------------------------------------ */

function mapNeed(row: CashNeedRow): CashNeed {
  return {
    id: row.id,
    projectId: row.project_id,
    opportunityId: row.opportunity_id,
    blockedAction: row.blocked_action,
    whyItMatters: row.why_it_matters,
    recommendedPath: row.recommended_path,
    expectedCostCents: row.expected_cost_cents,
    setupEffort: row.setup_effort,
    nextStep: row.next_step,
    completionCondition: row.completion_condition,
    occurrence: row.occurrence,
    verifiedBy: row.verified_by === null ? null : (row.verified_by as CashNeed['verifiedBy']),
    continuationClaimedAt: row.continuation_claimed_at,
    continuationAttempts: row.continuation_attempts,
    continuationNotBefore: row.continuation_not_before,
    blocksState: row.blocks_state === null ? null : (row.blocks_state as CashOpportunityState),
    candidateId: row.candidate_id,
    requestKey: row.request_key,
    continuedAt: row.continued_at,
    continuationNote: row.continuation_note,
    state: row.state as CashNeedState,
    resolution: row.resolution,
    resolvedByUserId: row.resolved_by_user_id,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createNeed(input: {
  projectId: string;
  opportunityId?: string | null;
  blockedAction: string;
  whyItMatters: string;
  recommendedPath: string;
  expectedCostCents?: number | null;
  setupEffort: string;
  nextStep: string;
  completionCondition: string;
  blocksState?: CashOpportunityState | null;
  candidateId?: string | null;
  requestKey?: string | null;
  occurrence?: number;
}): Promise<CashNeed> {
  const id = newId('cnd');
  const at = portfolioNow();
  await getDb().run(
    `INSERT INTO cash_needs
       (id, project_id, opportunity_id, blocked_action, why_it_matters, recommended_path,
        expected_cost_cents, setup_effort, next_step, completion_condition, occurrence,
        blocks_state, candidate_id, request_key, continued_at, continuation_note, state,
        resolution, resolved_by_user_id, resolved_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'OPEN', NULL, NULL, NULL, ?, ?)`,
    [
      id,
      input.projectId,
      input.opportunityId ?? null,
      input.blockedAction,
      input.whyItMatters,
      input.recommendedPath,
      input.expectedCostCents ?? null,
      input.setupEffort,
      input.nextStep,
      input.completionCondition,
      Math.max(1, Math.trunc(input.occurrence ?? 1)),
      input.blocksState ?? null,
      input.candidateId ?? null,
      input.requestKey ?? null,
      at,
      at,
    ],
  );
  const created = await getNeed(id);
  if (!created) throw new Error('The need disappeared immediately after being written.');
  return created;
}

/**
 * The need already raised for this condition, if one was.
 *
 * Read back rather than inserted-or-ignored, because the caller wants the row
 * either way: a capability need raised on a previous tick is the thing whose
 * continuation is waiting, not a duplicate to discard.
 */
export async function needForKey(
  projectId: string,
  requestKey: string,
): Promise<CashNeed | null> {
  const rows = await getDb().all<CashNeedRow>(
    `SELECT * FROM cash_needs WHERE project_id = ? AND request_key = ?
      ORDER BY occurrence DESC, created_at DESC, id DESC`,
    [projectId, requestKey],
  );
  return rows[0] ? mapNeed(rows[0]) : null;
}

/**
 * The still-*open* need for this condition.
 *
 * `needForKey` returns the newest whatever its state, and that is what made a
 * recurring blockage unraisable: a capability that went missing again found the
 * resolved row, was told it had already been raised, and never reached the
 * review. What a caller raising a need wants to know is whether one is
 * outstanding — and with `occurrence` on the unique index, the answer to "no"
 * is a new row rather than a collision.
 */
export async function openNeedForKey(
  projectId: string,
  requestKey: string,
): Promise<CashNeed | null> {
  const rows = await getDb().all<CashNeedRow>(
    `SELECT * FROM cash_needs WHERE project_id = ? AND request_key = ? AND state = 'OPEN'
      ORDER BY occurrence DESC, created_at DESC, id DESC`,
    [projectId, requestKey],
  );
  return rows[0] ? mapNeed(rows[0]) : null;
}

/** How many times this blockage has been raised, so the next one is the next. */
export async function occurrencesOf(projectId: string, requestKey: string): Promise<number> {
  const rows = await getDb().all<{ highest: number | null }>(
    'SELECT MAX(occurrence) AS highest FROM cash_needs WHERE project_id = ? AND request_key = ?',
    [projectId, requestKey],
  );
  return Number(rows[0]?.highest ?? 0);
}

/**
 * How long a continuation may hold its claim before another tick may retake it.
 *
 * A lease rather than a flag, for Step 5's reason: an expired lease is
 * claimable work, so recovery never depends on one process staying alive. A
 * tick that died between claiming and settling leaves a claim nothing else will
 * settle, and without this it leaves it for ever.
 */
export const CONTINUATION_LEASE_MS = 5 * 60 * 1000;

/**
 * Claim one settled need's continuation, recoverably.
 *
 * This wrote `continued_at` — permanently, terminally — **before** the
 * continuation ran, so a temporary refusal consumed the only attempt: no
 * commercial authority yet, no free execution slot, the piece not READY. The
 * ordinary path made that the common case rather than the rare one, because
 * filling a card leaves a piece at `EVIDENCE_CARD` and a need resolved then is
 * resolved before `READY` exists at all.
 *
 * So the claim is a lease, and `continued_at` is written by
 * `finishNeedContinuation` once the answer is terminal. The guard still carries
 * everything that makes the claim valid in the statement that takes it, so two
 * ticks still produce one continuation.
 */
export async function claimNeedContinuation(id: string, now?: string): Promise<boolean> {
  const at = now ?? portfolioNow();
  const stale = new Date(Date.parse(at) - CONTINUATION_LEASE_MS).toISOString();
  const result = await getDb().run(
    `UPDATE cash_needs
        SET continuation_claimed_at = ?,
            continuation_attempts = continuation_attempts + 1,
            updated_at = ?
      WHERE id = ?
        AND continued_at IS NULL
        AND state IN ('RESOLVED', 'WITHDRAWN')
        AND (continuation_claimed_at IS NULL OR continuation_claimed_at < ?)
        AND (continuation_not_before IS NULL OR continuation_not_before <= ?)`,
    [at, at, id, stale, at],
  );
  return result.changes === 1;
}

/**
 * The continuation reached a terminal answer: it resumed, or there was nothing
 * to resume. `continued_at` is what makes it final, and it is written once.
 */
export async function finishNeedContinuation(id: string, note: string): Promise<void> {
  const at = portfolioNow();
  await getDb().run(
    `UPDATE cash_needs
        SET continued_at = ?, continuation_note = ?, continuation_claimed_at = NULL,
            updated_at = ?
      WHERE id = ? AND continued_at IS NULL`,
    [at, note, at, id],
  );
}

/**
 * The continuation could not run *yet*, on a condition expected to stop being
 * true. The claim is released and the next attempt deferred, so the need is
 * retried rather than spent.
 *
 * Bounded backoff per attempt, because a condition nobody is going to fix
 * should become visible rather than be retried for ever at the same rate.
 */
export async function deferNeedContinuation(input: {
  id: string;
  note: string;
  attempts: number;
  now?: string;
}): Promise<void> {
  const at = input.now ?? portfolioNow();
  const rungs = [1, 2, 5, 15, 30, 60];
  const minutes = rungs[Math.min(Math.max(0, input.attempts), rungs.length - 1)] ?? 60;
  const next = new Date(Date.parse(at) + minutes * 60 * 1000).toISOString();
  await getDb().run(
    `UPDATE cash_needs
        SET continuation_claimed_at = NULL, continuation_not_before = ?,
            continuation_note = ?, updated_at = ?
      WHERE id = ? AND continued_at IS NULL`,
    [next, input.note, at, input.id],
  );
}

/**
 * The idea Brain started because of this need.
 *
 * Guarded on the column still being null, so a second pass can never re-point
 * a need at a different candidate — an observation that silently overwrote one
 * would hide which question was actually asked.
 */
export async function setNeedCandidate(id: string, candidateId: string): Promise<boolean> {
  const result = await getDb().run(
    'UPDATE cash_needs SET candidate_id = ?, updated_at = ? WHERE id = ? AND candidate_id IS NULL',
    [candidateId, portfolioNow(), id],
  );
  return result.changes === 1;
}

/** What the continuation did. Written once, by whoever claimed it. */
export async function recordNeedContinuation(id: string, note: string): Promise<void> {
  await getDb().run(
    'UPDATE cash_needs SET continuation_note = ?, updated_at = ? WHERE id = ?',
    [note, portfolioNow(), id],
  );
}

/**
 * The needs whose continuation has not run.
 *
 * Derived from the rows rather than hooked to the moment a need was answered,
 * which is the difference between a remedy that reaches the needs already
 * stranded and one that only reaches the next one — the third time this
 * repository has needed that distinction.
 */
export async function needsAwaitingContinuation(
  projectId: string,
  now?: string,
): Promise<CashNeed[]> {
  const at = now ?? portfolioNow();
  const rows = await getDb().all<CashNeedRow>(
    `SELECT * FROM cash_needs
      WHERE project_id = ? AND continued_at IS NULL AND state IN ('RESOLVED', 'WITHDRAWN')
        AND (continuation_not_before IS NULL OR continuation_not_before <= ?)
      ORDER BY resolved_at, id`,
    [projectId, at],
  );
  return rows.map(mapNeed);
}

export async function getNeed(id: string): Promise<CashNeed | null> {
  const rows = await getDb().all<CashNeedRow>('SELECT * FROM cash_needs WHERE id = ?', [id]);
  return rows[0] ? mapNeed(rows[0]) : null;
}

export async function listNeeds(input: {
  projectId: string;
  states?: CashNeedState[];
}): Promise<CashNeed[]> {
  if (input.states && input.states.length === 0) return [];
  const where = ['project_id = ?'];
  const params: SqlParam[] = [input.projectId];
  if (input.states) {
    where.push(`state IN (${input.states.map(() => '?').join(', ')})`);
    params.push(...input.states);
  }
  const rows = await getDb().all<CashNeedRow>(
    `SELECT * FROM cash_needs
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC, id DESC`,
    params,
  );
  return rows.map(mapNeed);
}

export async function settleNeed(input: {
  id: string;
  to: 'RESOLVED' | 'WITHDRAWN';
  resolution: string;
  actorUserId: string;
  /**
   * How the condition was established.
   *
   * Null for a withdrawal, which settles nothing — it says the need stopped
   * mattering rather than that it was met, and the two must not read alike.
   */
  verifiedBy?: CashNeed['verifiedBy'];
}): Promise<boolean> {
  const at = portfolioNow();
  const result = await getDb().run(
    `UPDATE cash_needs
        SET state = ?, resolution = ?, resolved_by_user_id = ?, resolved_at = ?,
            verified_by = ?, updated_at = ?
      WHERE id = ? AND state = 'OPEN'`,
    [input.to, input.resolution, input.actorUserId, at, input.verifiedBy ?? null, at, input.id],
  );
  return result.changes === 1;
}
