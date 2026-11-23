/**
 * READ-ONLY audit probe for the $10K goal (wst_7b4fcbb5f2384f31b6c3), sent by
 * the Goals workflow's census path from branch claude/audit-10k-plan. It is
 * never merged: it replaces the census script on this branch only. Every
 * statement is a SELECT; nothing is written.
 */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';

const GOAL = 'wst_7b4fcbb5f2384f31b6c3';
const PROJECT = 'prj_22fb4fec295f403a8a22';
const CLAIMS = ['clm_39c873b617d846da8292', 'clm_36a246dfddcf4b1ebccc', 'clm_5e038810b7a945728e2f'];

async function q(label: string, sql: string, params: unknown[] = []): Promise<void> {
  try {
    const rows = await getDb().all<Record<string, unknown>>(sql, params);
    console.log(`AUDIT ${label} ${JSON.stringify(rows)}`);
  } catch (error) {
    console.log(`AUDIT ${label} ERROR ${(error as Error).message.slice(0, 300)}`);
  }
}

async function main(): Promise<void> {
  await initDatabase();
  await q('workstream', 'SELECT * FROM workstreams WHERE id = ?', [GOAL]);
  await q('target', "SELECT * FROM goal_targets WHERE workstream_id = ?", [GOAL]);
  await q('readings', 'SELECT id, digest, verdict, chosen_strategy, created_at, LENGTH(forecast) AS forecast_len FROM goal_plan_readings WHERE workstream_id = ? ORDER BY created_at DESC LIMIT 8', [GOAL]);
  await q('latestForecast', 'SELECT id, created_at, forecast, next_test FROM goal_plan_readings WHERE workstream_id = ? ORDER BY created_at DESC LIMIT 1', [GOAL]);
  await q('firstCandidate98', "SELECT id, created_at FROM goal_plan_readings WHERE workstream_id = ? AND forecast LIKE '%arr_6f3b7a404ca5%' ORDER BY created_at ASC LIMIT 1", [GOAL]);
  await q('claimsById', `SELECT id, claim, source_url, source_title, source_publisher, source_date, evidence_excerpt, evidence_lane, accepted, validation_state, contradiction_state, confidence, retrieved_at FROM research_claims WHERE id IN (${CLAIMS.map(() => '?').join(',')})`, CLAIMS);
  await q('claimsDomain', `SELECT c.id, c.claim, c.source_url, c.source_title, c.evidence_excerpt, c.evidence_lane, c.accepted, c.retrieved_at FROM research_claims c JOIN research_orchestrations o ON o.id = c.orchestration_id WHERE o.project_id = ? AND c.accepted = 1 AND (c.claim LIKE '%domain buyer%' OR c.claim LIKE '%domain seller%' OR c.claim LIKE '%domain brok%' OR c.claim LIKE '%per unit of work%') LIMIT 12`, [PROJECT]);
  await q('claimsSmallBiz', `SELECT c.id, c.claim, c.source_url, c.source_title, c.evidence_excerpt, c.evidence_lane, c.accepted, c.retrieved_at FROM research_claims c JOIN research_orchestrations o ON o.id = c.orchestration_id WHERE o.project_id = ? AND c.accepted = 1 AND c.claim LIKE '%small business operator%' LIMIT 12`, [PROJECT]);
  await q('claimsGithub', `SELECT c.id, c.claim, c.source_url, c.source_title, c.evidence_excerpt, c.evidence_lane, c.accepted, c.retrieved_at FROM research_claims c JOIN research_orchestrations o ON o.id = c.orchestration_id WHERE o.project_id = ? AND c.accepted = 1 AND (c.claim LIKE '%bug bounty%' OR c.claim LIKE '%GitHub%') LIMIT 20`, [PROJECT]);
  await q('claims75', `SELECT c.id, c.claim, c.source_url, c.evidence_lane FROM research_claims c JOIN research_orchestrations o ON o.id = c.orchestration_id WHERE o.project_id = ? AND c.accepted = 1 AND (c.claim LIKE '%$75 %' OR c.claim LIKE '%$75.%' OR c.claim LIKE '% 75 USD%' OR c.claim LIKE '%$9 %' OR c.claim LIKE '%$9.%') LIMIT 20`, [PROJECT]);
  await q('githubOpening', 'SELECT * FROM cash_opportunities WHERE id = ?', ['cop_4521ad95cb104405a33e']);
  await q('constructionFacts', 'SELECT fact_key, segment, low, high, status, measures, source_title, source_url, created_at FROM construction_facts WHERE workstream_id = ? ORDER BY created_at DESC LIMIT 60', [GOAL]);
  await q('ledger', "SELECT * FROM goal_outcomes WHERE workstream_id = ? ORDER BY observed_at DESC LIMIT 5", [GOAL]);
  console.log('GOALS: OK');
}

main()
  .catch((error) => {
    console.log(`AUDIT FAILED ${(error as Error).message}`);
    console.log('GOALS: FAILED');
  })
  .finally(() => closeDatabase());
