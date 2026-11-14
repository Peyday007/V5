/**
 * Economic knowledge census (Surge B, 2026-11-14): what Brain durably holds,
 * counted from the authoritative rows — never from a configured limit.
 *
 * Read-only. One pooler client. Each population is one statement; a statement
 * that fails (a table this deployment does not have yet) prints UNMEASURED
 * with the reason instead of a number, because a guessed figure is worse than
 * an admitted gap. A population Brain computes but never stores is listed as
 * NOT_STORED with where it lives, so "400 arrangements per pass" is never read
 * as "400 businesses known".
 *
 *   node --import tsx scripts/knowledge-census.ts            # human lines
 *   node --import tsx scripts/knowledge-census.ts --json     # one JSON line too
 */
import { closeDatabase, getDb, initDatabase } from '../server/db/database.ts';

interface Population {
  key: string;
  /** Which of the owner's eight layers this counts (1 code … 8 commercially validated). */
  layer: 'STORED' | 'GENERATED' | 'EVIDENCED' | 'EVALUATED' | 'VALIDATED';
  label: string;
  sql?: string;
  /** For a population Brain does not store: where it exists, and why it cannot be counted. */
  notStored?: string;
}

const LIVE = 'retired_at IS NULL';

export const POPULATIONS: readonly Population[] = [
  { key: 'industries', layer: 'STORED', label: 'mapped industries (SECTOR nodes)', sql: `SELECT COUNT(*) AS n FROM industry_nodes WHERE kind = 'SECTOR' AND ${LIVE}` },
  { key: 'subindustries', layer: 'STORED', label: 'industry subcategories (SUB_INDUSTRY + VALUE_CHAIN_LAYER + ADJACENT_INDUSTRY)', sql: `SELECT COUNT(*) AS n FROM industry_nodes WHERE kind IN ('SUB_INDUSTRY', 'VALUE_CHAIN_LAYER', 'ADJACENT_INDUSTRY') AND ${LIVE}` },
  { key: 'nodes', layer: 'STORED', label: 'economic nodes (all industry_nodes)', sql: `SELECT COUNT(*) AS n FROM industry_nodes WHERE ${LIVE}` },
  { key: 'nodesDiscovered', layer: 'STORED', label: 'economic nodes Brain discovered (origin DISCOVERED)', sql: `SELECT COUNT(*) AS n FROM industry_nodes WHERE origin = 'DISCOVERED' AND ${LIVE}` },
  { key: 'buyerPopulations', layer: 'STORED', label: 'buyer populations (BUYER_TYPE nodes)', sql: `SELECT COUNT(*) AS n FROM industry_nodes WHERE kind = 'BUYER_TYPE' AND ${LIVE}` },
  { key: 'bottlenecks', layer: 'STORED', label: 'bottlenecks / customer needs (BOTTLENECK nodes)', sql: `SELECT COUNT(*) AS n FROM industry_nodes WHERE kind = 'BOTTLENECK' AND ${LIVE}` },
  { key: 'supplierCategories', layer: 'STORED', label: 'supplier categories (FULFILMENT_SOURCE nodes)', sql: `SELECT COUNT(*) AS n FROM industry_nodes WHERE kind = 'FULFILMENT_SOURCE' AND ${LIVE}` },
  { key: 'transactionTypes', layer: 'STORED', label: 'transaction mechanisms (TRANSACTION_TYPE nodes)', sql: `SELECT COUNT(*) AS n FROM industry_nodes WHERE kind = 'TRANSACTION_TYPE' AND ${LIVE}` },
  { key: 'projectsWithMap', layer: 'STORED', label: 'projects holding an industry map', sql: `SELECT COUNT(DISTINCT project_id) AS n FROM industry_nodes` },
  { key: 'opportunities', layer: 'STORED', label: 'openings held (cash_opportunities, not duplicates)', sql: `SELECT COUNT(*) AS n FROM cash_opportunities WHERE duplicate_of_id IS NULL` },
  { key: 'opportunityMechanisms', layer: 'STORED', label: 'distinct capture mechanisms on held openings', sql: `SELECT COUNT(DISTINCT mechanism) AS n FROM cash_opportunities` },
  { key: 'opportunityIndustries', layer: 'STORED', label: 'distinct industries named on held openings', sql: `SELECT COUNT(DISTINCT industry) AS n FROM cash_opportunities WHERE industry IS NOT NULL` },
  { key: 'moneyFlows', layer: 'EVIDENCED', label: 'recorded money flows (openings with a payer and a price)', sql: `SELECT COUNT(*) AS n FROM cash_opportunities WHERE payer IS NOT NULL AND price_cents IS NOT NULL AND duplicate_of_id IS NULL` },
  { key: 'claims', layer: 'EVIDENCED', label: 'research claims (all)', sql: `SELECT COUNT(*) AS n FROM research_claims` },
  { key: 'sourcedClaims', layer: 'EVIDENCED', label: 'independently sourced economic observations (SOURCED claims)', sql: `SELECT COUNT(*) AS n FROM research_claims WHERE validation_state = 'SOURCED'` },
  { key: 'sourcedDomains', layer: 'EVIDENCED', label: 'distinct source titles behind sourced claims', sql: `SELECT COUNT(DISTINCT source_title) AS n FROM research_claims WHERE validation_state = 'SOURCED'` },
  { key: 'constructionFacts', layer: 'EVIDENCED', label: 'construction facts (quantities with a status)', sql: `SELECT COUNT(*) AS n FROM construction_facts` },
  { key: 'constructionFactsObserved', layer: 'EVIDENCED', label: 'construction facts OBSERVED or VERIFIED', sql: `SELECT COUNT(*) AS n FROM construction_facts WHERE status IN ('OBSERVED', 'VERIFIED')` },
  { key: 'unresolvedVariables', layer: 'EVIDENCED', label: 'unresolved economic variables (construction facts still ESTIMATE/ASSUMPTION)', sql: `SELECT COUNT(*) AS n FROM construction_facts WHERE status IN ('ESTIMATE', 'ASSUMPTION')` },
  { key: 'constructedRoundsAsked', layer: 'GENERATED', label: 'constructed arrangements asked about (goal …-mx- rounds)', sql: `SELECT COUNT(*) AS n FROM cash_discovery_rounds WHERE bucket_id LIKE 'goal-%-mx-%'` },
  // The constructed-arrangement library (migration 151 / pg 142): CONSTRUCTED rows of the §49 ledger, one per structure per project.
  { key: 'constructedArrangementsKnown', layer: 'STORED', label: 'constructed arrangements durably stored (monetization_paths origin CONSTRUCTED)', sql: `SELECT COUNT(*) AS n FROM monetization_paths WHERE origin = 'CONSTRUCTED'` },
  { key: 'arrangementsUnique', layer: 'STORED', label: 'unique arrangement structures (distinct design_signature, across projects)', sql: `SELECT COUNT(DISTINCT design_signature) AS n FROM monetization_paths WHERE design_signature IS NOT NULL` },
  { key: 'arrangementsResearched', layer: 'EVIDENCED', label: 'stored arrangements that a research round asked about (asked_count > 0)', sql: `SELECT COUNT(*) AS n FROM monetization_paths WHERE origin = 'CONSTRUCTED' AND asked_count > 0` },
  { key: 'arrangementsEvaluated', layer: 'EVALUATED', label: 'stored arrangements quantitatively evaluated in a goal model (evaluated_count > 0)', sql: `SELECT COUNT(*) AS n FROM monetization_paths WHERE origin = 'CONSTRUCTED' AND evaluated_count > 0` },
  { key: 'arrangementsPicked', layer: 'EVALUATED', label: 'stored arrangements a goal model\'s best combination picked at least once', sql: `SELECT COUNT(DISTINCT path_id) AS n FROM monetization_path_evaluations WHERE picked = 1` },
  { key: 'arrangementsTransferred', layer: 'STORED', label: 'cross-industry transfers (construction_origin TRANSFER)', sql: `SELECT COUNT(*) AS n FROM monetization_paths WHERE origin = 'CONSTRUCTED' AND construction_origin = 'TRANSFER'` },
  { key: 'arrangementsEvidenced', layer: 'EVIDENCED', label: 'stored arrangements with real external evidence (an EVIDENCE fact on a gated claim)', sql: `SELECT COUNT(DISTINCT p.id) AS n FROM monetization_paths p JOIN monetization_path_facts f ON f.path_id = p.id AND f.kind = 'EVIDENCE' WHERE p.origin = 'CONSTRUCTED'` },
  { key: 'arrangementsRefuted', layer: 'EVIDENCED', label: 'stored arrangements research refuted (research_verdict REFUTED)', sql: `SELECT COUNT(*) AS n FROM monetization_paths WHERE origin = 'CONSTRUCTED' AND research_verdict = 'REFUTED'` },
  { key: 'planReadings', layer: 'EVALUATED', label: 'plans constructed (goal plan readings)', sql: `SELECT COUNT(*) AS n FROM goal_plan_readings` },
  { key: 'plannedGoals', layer: 'EVALUATED', label: 'goals with at least one plan reading', sql: `SELECT COUNT(DISTINCT workstream_id) AS n FROM goal_plan_readings` },
  { key: 'plansEvaluated', layer: 'EVALUATED', label: 'plans evaluated (readings with a scenario run)', sql: `SELECT COUNT(*) AS n FROM goal_plan_readings WHERE scenario_run_id IS NOT NULL` },
  { key: 'plansRecommendable', layer: 'VALIDATED', label: 'plans accepted (verdict RECOMMENDABLE)', sql: `SELECT COUNT(*) AS n FROM goal_plan_readings WHERE verdict = 'RECOMMENDABLE'` },
  { key: 'planOutcomes', layer: 'VALIDATED', label: 'plans independently verified by an outcome (goal_outcomes)', sql: `SELECT COUNT(*) AS n FROM goal_outcomes` },
  { key: 'objectiveReadings', layer: 'EVALUATED', label: 'non-cash objective plan readings', sql: `SELECT COUNT(*) AS n FROM goal_objective_readings` },
  { key: 'validatedOpenings', layer: 'VALIDATED', label: 'commercially validated openings (a payment recorded against them)', sql: `SELECT COUNT(DISTINCT opportunity_id) AS n FROM cash_money_entries WHERE opportunity_id IS NOT NULL AND kind = 'SETTLEMENT'` },
  { key: 'laborRoles', layer: 'STORED', label: 'labor roles', notStored: 'the labor kernel (079) stores labor openings, not a role vocabulary; roles appear only as text inside openings and construction prose' },
  { key: 'commercialPositions', layer: 'STORED', label: 'commercial positions', notStored: 'positions are a closed in-code table (cash/properties.ts capture structures), not rows; an arrangement records which it used' },
];

export interface CensusLine { key: string; layer: Population['layer']; label: string; value: number | null; note?: string }

export async function census(): Promise<CensusLine[]> {
  const db = getDb();
  const out: CensusLine[] = [];
  for (const one of POPULATIONS) {
    if (!one.sql) {
      out.push({ key: one.key, layer: one.layer, label: one.label, value: null, note: `NOT_STORED: ${one.notStored}` });
      continue;
    }
    try {
      const row = (await db.get(one.sql)) as { n: number | string } | undefined;
      out.push({ key: one.key, layer: one.layer, label: one.label, value: Number(row?.n ?? 0) });
    } catch (error) {
      const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
      out.push({ key: one.key, layer: one.layer, label: one.label, value: null, note: `UNMEASURED: ${message}` });
    }
  }
  return out;
}

async function main(): Promise<void> {
  await initDatabase();
  try {
    const lines = await census();
    console.log(`CENSUS at ${new Date().toISOString()} revision ${process.env.BRAIN_REVISION ?? '<unstamped>'}`);
    for (const one of lines) console.log(`CENSUS ${one.layer.padEnd(9)} ${one.key.padEnd(28)} ${one.value === null ? '-' : String(one.value).padStart(8)}  ${one.label}${one.note ? ` — ${one.note}` : ''}`);
    if (process.argv.includes('--json')) console.log(`CENSUS_JSON ${JSON.stringify(lines)}`);
    console.log('GOALS: OK');
  } finally {
    await closeDatabase();
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
