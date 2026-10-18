/**
 * Decisions Brain prepared and did not send.
 *
 * Append-only by version. `prepared_by` is BRAIN and `state` is
 * PREPARED_NOT_SENT, both by CHECK, so no row here can read as a person's
 * approval or as a submission that happened. Nothing reads this table to
 * decide a transition: it is what a person reads before acting outside Brain.
 */
import { createHash } from 'node:crypto';
import { getDb } from '../db/database.ts';
import { newId, nowIso } from './util.ts';
import type { CashPreparedDecisionRow } from '../domain/types.ts';

export interface PreparedDecision {
  id: string;
  opportunityId: string;
  version: number;
  buyerRequest: string;
  buyerRequestUrl: string;
  observedAt: string;
  observedStatus: string;
  scope: string;
  priceProposal: string;
  priceBasis: string;
  fulfillment: string;
  cashTiming: string;
  openQuestions: string[];
  proposalText: string;
  submissionBlockers: string[];
  decisionNeeded: string;
  preparedBy: 'BRAIN';
  state: 'PREPARED_NOT_SENT';
  createdAt: string;
}

export type PreparedContent = Omit<
  PreparedDecision,
  'id' | 'opportunityId' | 'version' | 'preparedBy' | 'state' | 'createdAt'
>;

function list(text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((one): one is string => typeof one === 'string') : [];
  } catch {
    return [];
  }
}

function mapRow(row: CashPreparedDecisionRow): PreparedDecision {
  return {
    id: row.id,
    opportunityId: row.opportunity_id,
    version: row.version,
    buyerRequest: row.buyer_request,
    buyerRequestUrl: row.buyer_request_url,
    observedAt: row.observed_at,
    observedStatus: row.observed_status,
    scope: row.scope,
    priceProposal: row.price_proposal,
    priceBasis: row.price_basis,
    fulfillment: row.fulfillment,
    cashTiming: row.cash_timing,
    openQuestions: list(row.open_questions),
    proposalText: row.proposal_text,
    submissionBlockers: list(row.submission_blockers),
    decisionNeeded: row.decision_needed,
    preparedBy: 'BRAIN',
    state: 'PREPARED_NOT_SENT',
    createdAt: row.created_at,
  };
}

export function preparedContentHash(content: PreparedContent): string {
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

/**
 * Record a version, unless the latest version already says exactly this.
 * A race between two writers is settled by the unique (opportunity, version)
 * index: the loser writes nothing and reads back the winner.
 */
export async function recordPreparedDecision(input: {
  projectId: string;
  opportunityId: string;
  content: PreparedContent;
}): Promise<{ decision: PreparedDecision; written: boolean }> {
  const hash = preparedContentHash(input.content);
  const latest = await latestPreparedFor(input.opportunityId);
  if (latest && preparedContentHash(contentOf(latest)) === hash) {
    return { decision: latest, written: false };
  }
  const c = input.content;
  const result = await getDb().run(
    `INSERT INTO cash_prepared_decisions
       (id, project_id, opportunity_id, version, content_hash, buyer_request,
        buyer_request_url, observed_at, observed_status, scope, price_proposal,
        price_basis, fulfillment, cash_timing, open_questions, proposal_text,
        submission_blockers, decision_needed, prepared_by, state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'BRAIN', 'PREPARED_NOT_SENT', ?)
     ON CONFLICT (opportunity_id, version) DO NOTHING`,
    [
      newId('cpd'),
      input.projectId,
      input.opportunityId,
      (latest?.version ?? 0) + 1,
      hash,
      c.buyerRequest,
      c.buyerRequestUrl,
      c.observedAt,
      c.observedStatus,
      c.scope,
      c.priceProposal,
      c.priceBasis,
      c.fulfillment,
      c.cashTiming,
      JSON.stringify(c.openQuestions),
      c.proposalText,
      JSON.stringify(c.submissionBlockers),
      c.decisionNeeded,
      nowIso(),
    ],
  );
  const now = await latestPreparedFor(input.opportunityId);
  if (!now) throw new Error('The prepared decision disappeared immediately after being written.');
  return { decision: now, written: result.changes > 0 };
}

export function contentOf(one: PreparedDecision): PreparedContent {
  return {
    buyerRequest: one.buyerRequest,
    buyerRequestUrl: one.buyerRequestUrl,
    observedAt: one.observedAt,
    observedStatus: one.observedStatus,
    scope: one.scope,
    priceProposal: one.priceProposal,
    priceBasis: one.priceBasis,
    fulfillment: one.fulfillment,
    cashTiming: one.cashTiming,
    openQuestions: one.openQuestions,
    proposalText: one.proposalText,
    submissionBlockers: one.submissionBlockers,
    decisionNeeded: one.decisionNeeded,
  };
}

export async function latestPreparedFor(opportunityId: string): Promise<PreparedDecision | null> {
  const row = await getDb().get<CashPreparedDecisionRow>(
    `SELECT * FROM cash_prepared_decisions WHERE opportunity_id = ? ORDER BY version DESC LIMIT 1`,
    [opportunityId],
  );
  return row ? mapRow(row) : null;
}

/** The latest version for every opportunity in a project, newest first. */
export async function latestPreparedForProject(projectId: string): Promise<PreparedDecision[]> {
  const rows = await getDb().all<CashPreparedDecisionRow>(
    `SELECT p.* FROM cash_prepared_decisions p
      WHERE p.project_id = ?
        AND p.version = (SELECT MAX(q.version) FROM cash_prepared_decisions q
                          WHERE q.opportunity_id = p.opportunity_id)
      ORDER BY p.created_at DESC, p.id DESC`,
    [projectId],
  );
  return rows.map(mapRow);
}
