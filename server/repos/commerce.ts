/**
 * The channels, the propositions, every reading about them, what has been
 * asked, and the one bounded test that spends.
 *
 * Every write here is idempotent by a unique index rather than by a read, for
 * the reason every other repository in this codebase is: the tick runs on more
 * than one instance, both halves of a check-then-write can read "there is no
 * row", and the arbiter has to be the database. A loser reads back the
 * winner's row and carries on, which is an ordinary outcome rather than an
 * error.
 */
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import type {
  CommerceChannel,
  CommerceChannelOrigin,
  CommerceChannelRow,
  CommerceEvidence,
  CommerceEvidenceOrigin,
  CommerceEvidenceRow,
  CommerceFinding,
  CommerceProposition,
  CommercePropositionRow,
  CommerceRound,
  CommerceRoundPurpose,
  CommerceRoundRow,
  CommerceTest,
  CommerceTestRow,
  CommerceTestState,
} from '../domain/types.ts';

/* ------------------------------------------------------------------ channels */

function mapChannel(row: CommerceChannelRow): CommerceChannel {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    origin: row.origin as CommerceChannelOrigin,
    sourceClaimId: row.source_claim_id,
    retiredAt: row.retired_at,
    retiredReason: row.retired_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Add a channel, or find the one that is already there.
 *
 * The name is the identity within a project, deliberately: two workers reading
 * two sources about one platform write the same name, and a second row would
 * split that channel's fee evidence between two records that nothing joins. It
 * is normalized to a single-spaced trimmed form so whitespace cannot make one
 * channel into two.
 *
 * `created` is decided by comparing the id back rather than by the driver's
 * changed count, which the two backends report differently for an insert that
 * conflicted.
 */
export async function createChannel(input: {
  projectId: string;
  name: string;
  description?: string | null;
  origin: CommerceChannelOrigin;
  sourceClaimId?: string | null;
}): Promise<{ channel: CommerceChannel; created: boolean }> {
  const name = input.name.replace(/\s+/g, ' ').trim();
  if (!name) throw new Error('A commerce channel must have a name.');
  if (input.origin !== 'SEED' && !input.sourceClaimId) {
    throw new Error('Only a seeded channel may exist without the claim that established it.');
  }
  const id = newId('cch');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO commerce_channels
       (id, project_id, name, description, origin, source_claim_id,
        retired_at, retired_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      name,
      input.description ?? null,
      input.origin,
      input.sourceClaimId ?? null,
      at,
      at,
    ],
  );
  const rows = await getDb().all<CommerceChannelRow>(
    'SELECT * FROM commerce_channels WHERE project_id = ? AND name = ?',
    [input.projectId, name],
  );
  if (!rows[0]) throw new Error('The commerce channel disappeared immediately after being written.');
  return { channel: mapChannel(rows[0]), created: rows[0].id === id };
}

export async function listChannels(projectId: string): Promise<CommerceChannel[]> {
  const rows = await getDb().all<CommerceChannelRow>(
    'SELECT * FROM commerce_channels WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapChannel);
}

export async function getChannel(id: string): Promise<CommerceChannel | null> {
  const rows = await getDb().all<CommerceChannelRow>(
    'SELECT * FROM commerce_channels WHERE id = ?',
    [id],
  );
  return rows[0] ? mapChannel(rows[0]) : null;
}

/**
 * A person decided this channel is not worth following.
 *
 * Not a delete, for the reason a retired industry node is not one: it is
 * evidence about where Brain has already been, and deleting it would let the
 * same channel arrive again as a fresh discovery on the next expansion.
 * Guarded on not already being retired, so two callers answering one decision
 * record it once and the first reason stands.
 */
export async function retireChannel(id: string, reason: string): Promise<boolean> {
  const at = nowIso();
  const result = await getDb().run(
    `UPDATE commerce_channels SET retired_at = ?, retired_reason = ?, updated_at = ?
      WHERE id = ? AND retired_at IS NULL`,
    [at, reason, at, id],
  );
  return result.changes === 1;
}

/* -------------------------------------------------------------- propositions */

function mapProposition(row: CommercePropositionRow): CommerceProposition {
  return {
    id: row.id,
    projectId: row.project_id,
    cashModeId: row.cash_mode_id,
    channelId: row.channel_id,
    product: row.product,
    audience: row.audience,
    supplier: row.supplier,
    opportunityId: row.opportunity_id,
    industryNodeId: row.industry_node_id,
    origin: row.origin as CommerceChannelOrigin,
    sourceClaimId: row.source_claim_id,
    retiredAt: row.retired_at,
    retiredReason: row.retired_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createProposition(input: {
  projectId: string;
  cashModeId: string;
  channelId: string;
  product: string;
  audience?: string | null;
  supplier?: string | null;
  opportunityId?: string | null;
  industryNodeId?: string | null;
  origin: CommerceChannelOrigin;
  sourceClaimId?: string | null;
}): Promise<{ proposition: CommerceProposition; created: boolean }> {
  const product = input.product.replace(/\s+/g, ' ').trim();
  if (!product) throw new Error('A proposition must name a product.');
  if (input.origin !== 'SEED' && !input.sourceClaimId) {
    throw new Error('Only a seeded proposition may exist without the claim that established it.');
  }
  const id = newId('cpr');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO commerce_propositions
       (id, project_id, cash_mode_id, channel_id, product, audience, supplier,
        opportunity_id, industry_node_id, origin, source_claim_id,
        retired_at, retired_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.cashModeId,
      input.channelId,
      product,
      input.audience ?? null,
      input.supplier ?? null,
      input.opportunityId ?? null,
      input.industryNodeId ?? null,
      input.origin,
      input.sourceClaimId ?? null,
      at,
      at,
    ],
  );
  const rows = await getDb().all<CommercePropositionRow>(
    'SELECT * FROM commerce_propositions WHERE project_id = ? AND channel_id = ? AND product = ?',
    [input.projectId, input.channelId, product],
  );
  if (!rows[0]) throw new Error('The proposition disappeared immediately after being written.');
  return { proposition: mapProposition(rows[0]), created: rows[0].id === id };
}

export async function listPropositions(projectId: string): Promise<CommerceProposition[]> {
  const rows = await getDb().all<CommercePropositionRow>(
    'SELECT * FROM commerce_propositions WHERE project_id = ? ORDER BY created_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapProposition);
}

export async function getProposition(id: string): Promise<CommerceProposition | null> {
  const rows = await getDb().all<CommercePropositionRow>(
    'SELECT * FROM commerce_propositions WHERE id = ?',
    [id],
  );
  return rows[0] ? mapProposition(rows[0]) : null;
}

/**
 * Fill in what a later round established about a proposition.
 *
 * Only ever fills a blank. A research round that establishes the audience must
 * not overwrite an audience a person stated, and two rounds establishing two
 * different suppliers must not race — the first one filed stands, and the
 * second is still on its own evidence row where a reader can see the
 * disagreement. §5 at a column: new evidence never silently overwrites old.
 */
export async function fillProposition(input: {
  id: string;
  audience?: string | null;
  supplier?: string | null;
  opportunityId?: string | null;
  industryNodeId?: string | null;
}): Promise<boolean> {
  const sets: string[] = [];
  const args: string[] = [];
  const add = (column: string, value: string | null | undefined) => {
    if (value === undefined || value === null || value === '') return;
    sets.push(`${column} = ?`);
    args.push(value);
  };
  add('audience', input.audience);
  add('supplier', input.supplier);
  add('opportunity_id', input.opportunityId);
  add('industry_node_id', input.industryNodeId);
  if (sets.length === 0) return false;

  const blanks = sets.map((one) => `${one.split(' = ')[0]} IS NULL`).join(' OR ');
  const at = nowIso();
  const result = await getDb().run(
    `UPDATE commerce_propositions SET ${sets.join(', ')}, updated_at = ?
      WHERE id = ? AND (${blanks})`,
    [...args, at, input.id],
  );
  return result.changes === 1;
}

export async function retireProposition(id: string, reason: string): Promise<boolean> {
  const at = nowIso();
  const result = await getDb().run(
    `UPDATE commerce_propositions SET retired_at = ?, retired_reason = ?, updated_at = ?
      WHERE id = ? AND retired_at IS NULL`,
    [at, reason, at, id],
  );
  return result.changes === 1;
}

/* ------------------------------------------------------------------ evidence */

function mapEvidence(row: CommerceEvidenceRow): CommerceEvidence {
  return {
    id: row.id,
    projectId: row.project_id,
    propositionId: row.proposition_id,
    channelId: row.channel_id,
    kind: row.kind as CommerceFinding,
    statement: row.statement,
    origin: row.origin as CommerceEvidenceOrigin,
    sourceClaimId: row.source_claim_id,
    testId: row.test_id,
    actorRef: row.actor_ref,
    amountMinor: row.amount_minor,
    ratePpm: row.rate_ppm,
    days: row.days,
    countUnits: row.count_units,
    observedAt: row.observed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * File one reading.
 *
 * A claim-backed reading is idempotent by `(source_claim_id, kind)`, so a tick
 * that re-reads a finished mission writes what it wrote before rather than a
 * second copy. A test's and a person's are deliberately not: two readings of
 * one number at two times are the history this table exists to keep, and
 * collapsing them would destroy the estimate that decided to run the test.
 */
export async function recordEvidence(input: {
  projectId: string;
  propositionId?: string | null;
  channelId?: string | null;
  kind: CommerceFinding;
  statement: string;
  origin: CommerceEvidenceOrigin;
  sourceClaimId?: string | null;
  testId?: string | null;
  actorRef?: string | null;
  amountMinor?: number | null;
  ratePpm?: number | null;
  days?: number | null;
  countUnits?: number | null;
  observedAt?: string | null;
}): Promise<CommerceEvidence | null> {
  const id = newId('cev');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO commerce_evidence
       (id, project_id, proposition_id, channel_id, kind, statement, origin,
        source_claim_id, test_id, actor_ref, amount_minor, rate_ppm, days,
        count_units, observed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.propositionId ?? null,
      input.channelId ?? null,
      input.kind,
      input.statement,
      input.origin,
      input.sourceClaimId ?? null,
      input.testId ?? null,
      input.actorRef ?? null,
      input.amountMinor ?? null,
      input.ratePpm ?? null,
      input.days ?? null,
      input.countUnits ?? null,
      input.observedAt ?? null,
      at,
      at,
    ],
  );
  const rows = await getDb().all<CommerceEvidenceRow>(
    'SELECT * FROM commerce_evidence WHERE id = ?',
    [id],
  );
  return rows[0] ? mapEvidence(rows[0]) : null;
}

export async function listEvidenceForProject(projectId: string): Promise<CommerceEvidence[]> {
  const rows = await getDb().all<CommerceEvidenceRow>(
    `SELECT * FROM commerce_evidence WHERE project_id = ?
      ORDER BY created_at ASC, id ASC`,
    [projectId],
  );
  return rows.map(mapEvidence);
}

/* -------------------------------------------------------------------- rounds */

function mapRound(row: CommerceRoundRow): CommerceRound {
  return {
    id: row.id,
    projectId: row.project_id,
    cashModeId: row.cash_mode_id,
    purpose: row.purpose as CommerceRoundPurpose,
    channelId: row.channel_id,
    propositionId: row.proposition_id,
    round: row.round,
    candidateId: row.candidate_id,
    state: row.state as CommerceRound['state'],
    openedAt: row.opened_at,
    harvestedAt: row.harvested_at,
    found: row.found,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function openCommerceRound(input: {
  projectId: string;
  cashModeId: string;
  purpose: CommerceRoundPurpose;
  channelId?: string | null;
  propositionId?: string | null;
  round: number;
  candidateId: string;
}): Promise<{ round: CommerceRound; created: boolean }> {
  const id = newId('crn');
  const at = nowIso();
  const round = Math.max(1, Math.trunc(input.round));
  await getDb().run(
    `INSERT INTO commerce_rounds
       (id, project_id, cash_mode_id, purpose, channel_id, proposition_id, round,
        candidate_id, state, opened_at, harvested_at, found, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, NULL, NULL, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.cashModeId,
      input.purpose,
      input.channelId ?? null,
      input.propositionId ?? null,
      round,
      input.candidateId,
      at,
      at,
      at,
    ],
  );
  const rows = await getDb().all<CommerceRoundRow>(
    `SELECT * FROM commerce_rounds
      WHERE project_id = ? AND purpose = ?
        AND COALESCE(channel_id, '-') = ? AND COALESCE(proposition_id, '-') = ?
        AND round = ?`,
    [input.projectId, input.purpose, input.channelId ?? '-', input.propositionId ?? '-', round],
  );
  if (!rows[0]) throw new Error('The commerce round disappeared immediately after being written.');
  return { round: mapRound(rows[0]), created: rows[0].id === id };
}

export async function listCommerceRounds(projectId: string): Promise<CommerceRound[]> {
  const rows = await getDb().all<CommerceRoundRow>(
    'SELECT * FROM commerce_rounds WHERE project_id = ? ORDER BY opened_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapRound);
}

/** Every live round of this project, keyed by the idea it asked. */
export async function openCommerceRoundsByCandidate(
  projectId: string,
): Promise<Map<string, CommerceRound>> {
  const rows = await getDb().all<CommerceRoundRow>(
    "SELECT * FROM commerce_rounds WHERE project_id = ? AND state = 'OPEN'",
    [projectId],
  );
  return new Map(rows.map((row) => [row.candidate_id, mapRound(row)]));
}

export async function commerceRoundForCandidate(
  candidateId: string,
): Promise<CommerceRound | null> {
  const rows = await getDb().all<CommerceRoundRow>(
    'SELECT * FROM commerce_rounds WHERE candidate_id = ?',
    [candidateId],
  );
  return rows[0] ? mapRound(rows[0]) : null;
}

/**
 * Settle a round with what it produced, including nothing.
 *
 * Guarded on still being OPEN, so two ticks reading one finished mission
 * settle it once. `found` is what the next round is decided against, so a
 * barren round has to record its zero rather than staying open and looking as
 * though it were still running.
 */
export async function closeCommerceRound(input: {
  id: string;
  to: 'HARVESTED' | 'ABANDONED';
  found: number;
}): Promise<boolean> {
  const at = nowIso();
  const result = await getDb().run(
    `UPDATE commerce_rounds SET state = ?, harvested_at = ?, found = ?, updated_at = ?
      WHERE id = ? AND state = 'OPEN'`,
    [input.to, at, Math.max(0, Math.trunc(input.found)), at, input.id],
  );
  return result.changes === 1;
}

/* --------------------------------------------------------------------- tests */

function mapTest(row: CommerceTestRow): CommerceTest {
  return {
    id: row.id,
    projectId: row.project_id,
    propositionId: row.proposition_id,
    state: row.state as CommerceTestState,
    ceilingMinor: row.ceiling_minor,
    authorityId: row.authority_id,
    commitmentId: row.commitment_id,
    blockerKind: row.blocker_kind,
    blockerDetail: row.blocker_detail,
    stopRule: row.stop_rule,
    authorizedBy: row.authorized_by,
    openedAt: row.opened_at,
    settledAt: row.settled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Open a bounded test, or find the live one that is already there.
 *
 * The partial unique index is the arbiter, so two callers preparing one test
 * produce one row and the loser reads the winner's back. It can therefore be
 * re-run safely on every tick: a blocked test whose blocker has not changed is
 * the same row, and `updateTest` is what moves it when something does.
 */
export async function openTest(input: {
  projectId: string;
  propositionId: string;
  state: CommerceTestState;
  ceilingMinor: number;
  authorityId?: string | null;
  blockerKind?: string | null;
  blockerDetail?: string | null;
  stopRule: string;
  authorizedBy?: string | null;
}): Promise<{ test: CommerceTest; created: boolean }> {
  const id = newId('cts');
  const at = nowIso();
  await getDb().run(
    `INSERT INTO commerce_tests
       (id, project_id, proposition_id, state, ceiling_minor, authority_id, commitment_id,
        blocker_kind, blocker_detail, stop_rule, authorized_by, opened_at, settled_at,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?)
     ON CONFLICT DO NOTHING`,
    [
      id,
      input.projectId,
      input.propositionId,
      input.state,
      Math.max(0, Math.trunc(input.ceilingMinor)),
      input.authorityId ?? null,
      input.blockerKind ?? null,
      input.blockerDetail ?? null,
      input.stopRule,
      input.authorizedBy ?? null,
      at,
      at,
      at,
    ],
  );
  const rows = await getDb().all<CommerceTestRow>(
    `SELECT * FROM commerce_tests
      WHERE proposition_id = ? AND state IN ('BLOCKED', 'AUTHORIZED', 'RUNNING')`,
    [input.propositionId],
  );
  if (!rows[0]) {
    // The insert was refused and nothing live is there, which means a settled
    // test already answered this proposition. Reported as not created rather
    // than retried: re-testing a settled question is a person's decision.
    const settled = await getDb().all<CommerceTestRow>(
      'SELECT * FROM commerce_tests WHERE proposition_id = ? ORDER BY opened_at DESC, id DESC',
      [input.propositionId],
    );
    if (!settled[0]) throw new Error('The bounded test disappeared immediately after being written.');
    return { test: mapTest(settled[0]), created: false };
  }
  return { test: mapTest(rows[0]), created: rows[0].id === id };
}

/**
 * Move a test, naming the state it is moving from.
 *
 * A compare-and-swap rather than a write, for the reason every transition in
 * this codebase is one: two ticks reading one condition must produce one move,
 * and a late mover must match nothing rather than reopening something that has
 * since settled.
 */
export async function updateTest(input: {
  id: string;
  from: CommerceTestState;
  to: CommerceTestState;
  blockerKind?: string | null;
  blockerDetail?: string | null;
  authorityId?: string | null;
  commitmentId?: string | null;
  authorizedBy?: string | null;
}): Promise<boolean> {
  const at = nowIso();
  const result = await getDb().run(
    `UPDATE commerce_tests
        SET state = ?,
            blocker_kind = ?,
            blocker_detail = ?,
            authority_id = COALESCE(?, authority_id),
            commitment_id = COALESCE(?, commitment_id),
            authorized_by = COALESCE(?, authorized_by),
            settled_at = CASE WHEN ? = 'SETTLED' THEN ? ELSE settled_at END,
            updated_at = ?
      WHERE id = ? AND state = ?`,
    [
      input.to,
      input.to === 'BLOCKED' ? (input.blockerKind ?? null) : null,
      input.to === 'BLOCKED' ? (input.blockerDetail ?? null) : null,
      input.authorityId ?? null,
      input.commitmentId ?? null,
      input.authorizedBy ?? null,
      input.to,
      at,
      at,
      input.id,
      input.from,
    ],
  );
  return result.changes === 1;
}

export async function listTests(projectId: string): Promise<CommerceTest[]> {
  const rows = await getDb().all<CommerceTestRow>(
    'SELECT * FROM commerce_tests WHERE project_id = ? ORDER BY opened_at ASC, id ASC',
    [projectId],
  );
  return rows.map(mapTest);
}

export async function getTest(id: string): Promise<CommerceTest | null> {
  const rows = await getDb().all<CommerceTestRow>('SELECT * FROM commerce_tests WHERE id = ?', [id]);
  return rows[0] ? mapTest(rows[0]) : null;
}
