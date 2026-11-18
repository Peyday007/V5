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
 * Then a DIAG section per project holding a map or a cash row: why the F3
 * back-fill files no construction fact and the F7 arrangement rounds open none,
 * read from the functions the tick runs (`kernelSkips`, `kernelAuthority`,
 * `knowledgeResearchAllowed`) and the back-fill's own selection as a dry run
 * (`backfillCandidates`). Nothing is written.
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
  // The constructed-arrangement library (migration 152 / pg 143): CONSTRUCTED rows of the §49 ledger, one per structure per project.
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
  // §92 positions as rows (migration 155 / pg 146, K-6): each stored arrangement carries the position its design occupies.
  { key: 'commercialPositions', layer: 'STORED', label: 'commercial positions (distinct §92 position_key on stored arrangements)', sql: `SELECT COUNT(DISTINCT position_key) AS n FROM monetization_paths WHERE origin = 'CONSTRUCTED' AND position_key IS NOT NULL` },
  { key: 'arrangementsPositioned', layer: 'STORED', label: 'stored arrangements carrying a §92 position (position_json)', sql: `SELECT COUNT(*) AS n FROM monetization_paths WHERE origin = 'CONSTRUCTED' AND position_json IS NOT NULL` },
  { key: 'positionMoneyFlows', layer: 'STORED', label: 'constructed money flows (distinct payer population × position, money timing included)', sql: `SELECT COUNT(*) AS n FROM (SELECT DISTINCT COALESCE(opportunity_id, industry_node_id, design_signature) AS payer, position_key FROM monetization_paths WHERE origin = 'CONSTRUCTED' AND position_key IS NOT NULL) flows` },
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

/* ------------------------------------------------------------------ DIAG */

/** Projects the diagnosis reads, at most. */
const DIAG_PROJECTS = 50;
/** Rejection reasons and unmatched buyer wordings printed per project, at most. */
const DIAG_TOP = 8;

export interface DiagProject {
  projectId: string;
  cashMode: { exists: boolean; state: string | null };
  /** Why `runIndustryKernel` returns before absorbing and back-filling; null when it goes on. */
  kernelSkips: string | null;
  kernelAuthority: { allowed: boolean; basis: string | null; reason: string };
  standingGrant: { live: boolean; id: string | null; name: string | null; standingGoals: { name: string; state: string; expiresAt: string | null; research: boolean }[] };
  /** industry_rounds opened in the last 24 h, by `purpose:state`. */
  kernelRounds24h: Record<string, number>;
  /** Constructed-arrangement rounds (`goal-…-mx-…`, the F7 path) opened in the last 24 h, by state. */
  constructedRounds24h: Record<string, number>;
  knowledgeResearch: { allowed: boolean; basis: string | null; reason: string };
  /** The constructed-round gate (`openConstructedRound`) per goal: rounds still researching against the live cap, and the focus cap. */
  constructedGate: { goalId: string; goalRounds: number; stillResearching: number; liveCap: number; focusCap: number | null; liveConstructed: number; recentMx: number }[];
  backfill: {
    hasBuyerTypes: boolean;
    unitEconomicRead: number;
    read: number;
    candidates: number;
    candidatesBySource: Record<string, number>;
    rejected: number;
    topReasons: { reason: string; n: number }[];
    topUnmatchedBuyers: { buyer: string; n: number }[];
  } | { error: string };
  errors: string[];
}

function top(counts: Map<string, number>, limit = DIAG_TOP): { key: string; n: number }[] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([key, n]) => ({ key, n }));
}

function message(error: unknown): string {
  return error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error);
}

/** The projects holding an industry map or a cash mode row, bounded. */
export async function diagProjectIds(limit = DIAG_PROJECTS): Promise<string[]> {
  const rows = (await getDb().all(
    `SELECT project_id FROM (SELECT DISTINCT project_id FROM industry_nodes UNION SELECT project_id FROM cash_modes) p ORDER BY project_id LIMIT ?`,
    [limit],
  )) as { project_id: string }[];
  return rows.map((row) => row.project_id);
}

async function countBy(sql: string, params: string[]): Promise<Record<string, number>> {
  const rows = (await getDb().all(sql, params)) as { k: string; n: number | string }[];
  return Object.fromEntries(rows.map((row) => [row.k, Number(row.n)]));
}

/**
 * Why construction facts and arrangement research are (not) happening in one
 * project, read from the same functions the tick runs. Strictly read-only: the
 * back-fill is the dry-run selection (`backfillCandidates`), nothing is filed.
 */
export async function diagProject(projectId: string, now = new Date()): Promise<DiagProject> {
  const { getCashMode } = await import('../server/repos/cashMode.ts');
  const { listGoals } = await import('../server/repos/russellAuthority.ts');
  const { kernelAuthority, kernelSkips, standingWorldGrant } = await import('../server/services/industry/kernel.ts');
  const { backfillCandidates } = await import('../server/services/industry/expand.ts');
  const { knowledgeResearchAllowed } = await import('../server/services/cash/lifecycle.ts');
  const { RESEARCH_WORK_CLASS } = await import('../server/services/russell/launch.ts');

  const iso = now.toISOString();
  const since = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const errors: string[] = [];
  const attempt = async <T>(label: string, run: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      errors.push(`${label}: ${message(error)}`);
      return fallback;
    }
  };

  const mode = await attempt('cashMode', () => getCashMode(projectId), null);
  const goals = await attempt('listGoals', () => listGoals(projectId), []);
  const grant = standingWorldGrant(goals, iso);
  const skips = await attempt('kernelSkips', () => kernelSkips(projectId, mode), `unreadable`);
  const authority = await attempt('kernelAuthority', async () => {
    const one = await kernelAuthority(projectId, { mode, now: iso });
    return { allowed: one.allowed, basis: one.basis, reason: one.reason };
  }, { allowed: false, basis: null, reason: 'unreadable' });
  const knowledge = await attempt('knowledgeResearchAllowed', async () => {
    const one = await knowledgeResearchAllowed(projectId, iso);
    return { allowed: one.allowed, basis: one.basis, reason: one.reason };
  }, { allowed: false, basis: null, reason: 'unreadable' });
  const kernelRounds24h = await attempt(
    'industryRounds',
    () => countBy(`SELECT purpose || ':' || state AS k, COUNT(*) AS n FROM industry_rounds WHERE project_id = ? AND opened_at >= ? GROUP BY purpose, state ORDER BY k LIMIT 40`, [projectId, since]),
    {},
  );
  const constructedRounds24h = await attempt(
    'constructedRounds',
    () => countBy(`SELECT state AS k, COUNT(*) AS n FROM cash_discovery_rounds WHERE project_id = ? AND opened_at >= ? AND bucket_id LIKE 'goal-%-mx-%' GROUP BY state ORDER BY k LIMIT 10`, [projectId, since]),
    {},
  );

  const constructedGate = await attempt('constructedGate', async () => {
    const { roundsStillResearching, liveConstructedResearch, MAX_LIVE_GOAL_ROUNDS } = await import('../server/services/cash/discovery.ts');
    const { listRounds } = await import('../server/repos/cashDiscovery.ts');
    const { constructedCapFor } = await import('../server/services/cash/researchRoom.ts');
    const rounds = await listRounds(projectId);
    const goalIds = [...new Set(rounds.map((one) => /^goal-(wst_[A-Za-z0-9]+)/.exec(one.bucketId)?.[1]).filter((id): id is string => !!id))].slice(0, 5);
    const focusCap = await constructedCapFor(projectId);
    const out: DiagProject['constructedGate'] = [];
    for (const goalId of goalIds) {
      const prefix = `goal-${goalId}`;
      const mine = rounds.filter((one) => one.bucketId === prefix || one.bucketId.startsWith(`${prefix}-`));
      const mx = mine.filter((one) => one.bucketId.startsWith(`${prefix}-mx-`));
      out.push({
        goalId,
        goalRounds: mine.length,
        stillResearching: await roundsStillResearching(mine),
        liveCap: MAX_LIVE_GOAL_ROUNDS,
        focusCap,
        liveConstructed: await liveConstructedResearch(mx),
        recentMx: mx.filter((one) => one.openedAt >= since).length,
      });
    }
    return out;
  }, []);

  let backfill: DiagProject['backfill'];
  try {
    const pool = await backfillCandidates(projectId);
    const reasons = new Map<string, number>();
    const unmatched = new Map<string, number>();
    const bySource: Record<string, number> = {};
    let candidates = 0;
    for (const one of pool.decisions) {
      if (one.candidate) {
        candidates += 1;
        bySource[one.source] = (bySource[one.source] ?? 0) + 1;
        continue;
      }
      const reason = `${one.source}: ${one.reason ?? 'unknown'}`;
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      if (one.unmatchedBuyer) {
        const buyer = one.unmatchedBuyer.slice(0, 80);
        unmatched.set(buyer, (unmatched.get(buyer) ?? 0) + 1);
      }
    }
    backfill = {
      hasBuyerTypes: pool.hasBuyerTypes,
      unitEconomicRead: pool.unitEconomicRead,
      read: pool.decisions.length,
      candidates,
      candidatesBySource: bySource,
      rejected: pool.decisions.length - candidates,
      topReasons: top(reasons).map(({ key, n }) => ({ reason: key, n })),
      topUnmatchedBuyers: top(unmatched).map(({ key, n }) => ({ buyer: key, n })),
    };
  } catch (error) {
    backfill = { error: message(error) };
  }

  return {
    projectId,
    cashMode: { exists: !!mode, state: mode?.state ?? null },
    kernelSkips: skips,
    kernelAuthority: authority,
    standingGrant: {
      live: !!grant,
      id: grant?.id ?? null,
      name: grant?.name ?? null,
      standingGoals: goals.slice(0, 5).map((goal) => ({ name: goal.name, state: goal.state, expiresAt: goal.expiresAt ?? null, research: goal.allowedWork.includes(RESEARCH_WORK_CLASS) })),
    },
    kernelRounds24h,
    constructedRounds24h,
    constructedGate,
    knowledgeResearch: knowledge,
    backfill,
    errors,
  };
}

export async function diagnose(now = new Date()): Promise<DiagProject[]> {
  const out: DiagProject[] = [];
  for (const projectId of await diagProjectIds()) out.push(await diagProject(projectId, now));
  return out;
}

/** The lines `main` prints for one project's diagnosis. */
export function diagLines(one: DiagProject): string[] {
  const p = `DIAG ${one.projectId}`;
  const kv = (record: Record<string, number>) => Object.entries(record).map(([k, n]) => `${k}=${n}`).join(' ') || 'none';
  const lines = [
    `${p} cashMode ${one.cashMode.exists ? one.cashMode.state : 'NO_ROW'}`,
    `${p} standingGrant ${one.standingGrant.live ? `LIVE ${one.standingGrant.name} (${one.standingGrant.id})` : 'NONE'}; standing goals: ${one.standingGrant.standingGoals.map((g) => `${g.name}[${g.state}${g.research ? ',RESEARCH' : ''}${g.expiresAt ? `,exp ${g.expiresAt}` : ''}]`).join(' ') || 'none'}`,
    `${p} kernelSkips ${one.kernelSkips ?? 'no (the pass absorbs and back-fills)'}`,
    `${p} kernelAuthority ${one.kernelAuthority.allowed ? `ALLOWED ${one.kernelAuthority.basis}` : 'REFUSED'} — ${one.kernelAuthority.reason}`,
    `${p} kernelRounds24h ${kv(one.kernelRounds24h)}`,
    `${p} constructedRounds24h ${kv(one.constructedRounds24h)}`,
    ...one.constructedGate.map((g) => `${p} constructedGate ${g.goalId} researching=${g.stillResearching}/${g.liveCap} (of ${g.goalRounds} goal rounds) focusCap=${g.focusCap ?? 'none'} liveConstructed=${g.liveConstructed} mx24h=${g.recentMx}`),
    `${p} knowledgeResearch ${one.knowledgeResearch.allowed ? `ALLOWED ${one.knowledgeResearch.basis}` : 'REFUSED'} — ${one.knowledgeResearch.reason}`,
  ];
  const b = one.backfill;
  if ('error' in b) lines.push(`${p} backfill UNMEASURED — ${b.error}`);
  else {
    lines.push(`${p} backfill buyerTypes=${b.hasBuyerTypes ? 'yes' : 'NONE'} unitEconomicRead=${b.unitEconomicRead} read=${b.read} candidates=${b.candidates} (${kv(b.candidatesBySource)}) rejected=${b.rejected}`);
    for (const r of b.topReasons) lines.push(`${p} backfillRejected ${String(r.n).padStart(5)}  ${r.reason}`);
    for (const u of b.topUnmatchedBuyers) lines.push(`${p} backfillUnmatchedBuyer ${String(u.n).padStart(5)}  ${u.buyer}`);
  }
  for (const e of one.errors) lines.push(`${p} error ${e}`);
  return lines;
}


/** One-off B1d trace (diagnostic branch only, never merged). */
async function traceB1d(): Promise<void> {
  const db = getDb();
  const show = (label: string, value: unknown) => console.log(`TRACE ${label} ${JSON.stringify(value, (_k, v) => (typeof v === 'string' && v.length > 300 ? `${v.slice(0, 300)}…` : v))}`);
  const q = async (label: string, sql: string, params: unknown[]) => {
    try {
      const rows = (await db.all(sql, params as string[])) as Record<string, unknown>[];
      show(`${label} n=${rows.length}`, rows);
      return rows;
    } catch (error) {
      show(`${label} ERROR`, message(error));
      return [];
    }
  };
  const P = 'prj_22fb4fec295f403a8a22';
  const KEY = '2821cce3c372';
  const claims = await q('claims', `SELECT id, orchestration_id, accepted, source_url IS NOT NULL AS has_url, structural_finding, structural_amount_cents, created_at, claim FROM research_claims WHERE claim LIKE ? ORDER BY id LIMIT 20`, ['%Oppizi%']);
  const orchIds = [...new Set(claims.map((c) => String(c.orchestration_id)))];
  for (const o of orchIds) {
    await q(`orch ${o}`, `SELECT * FROM research_orchestrations WHERE id = ?`, [o]);
    const missions = await q(`missions ${o}`, `SELECT * FROM russell_missions WHERE orchestration_id = ?`, [o]);
    for (const m of missions) await q(`roundsByCandidate ${String(m.candidate_id)}`, `SELECT * FROM cash_discovery_rounds WHERE candidate_id = ?`, [String(m.candidate_id)]);
  }
  for (const c of claims) await q(`facts ${String(c.id)}`, `SELECT id, node_id, fact_key, low, high, status, created_at FROM construction_facts WHERE source_claim_id = ?`, [String(c.id)]);
  await q('roundsByKey', `SELECT * FROM cash_discovery_rounds WHERE bucket_id LIKE ? ORDER BY opened_at`, [`%${KEY}%`]);
  const paths = await q('pathsByKey', `SELECT id, project_id, opportunity_id, industry_node_id, legacy_key, design_signature IS NOT NULL AS has_sig, updated_at FROM monetization_paths WHERE legacy_key = ? ORDER BY updated_at DESC`, [KEY]);
  for (const one of paths) if (one.industry_node_id) await q(`node ${String(one.industry_node_id)}`, `SELECT id, kind, name, retired_at FROM industry_nodes WHERE id = ?`, [String(one.industry_node_id)]);
  await q('planArrangements', `SELECT id, opportunity_id, industry_node_id, legacy_key, design_signature IS NOT NULL AS has_sig FROM monetization_paths WHERE id IN (?, ?, ?) OR legacy_key IN (?, ?, ?)`, ['arr_9b8b17b801cb', 'arr_86da3f1661d1', 'arr_4cbbf91e4df7', '9b8b17b801cb', '86da3f1661d1', '4cbbf91e4df7']);
  await q('pathsWithNode', `SELECT COUNT(*) AS n, SUM(CASE WHEN industry_node_id IS NOT NULL THEN 1 ELSE 0 END) AS with_node FROM monetization_paths WHERE project_id = ? AND design_signature IS NOT NULL`, [P]);
  await q('priceFacts', `SELECT fact_key, status, COUNT(*) AS n, MAX(created_at) AS latest FROM construction_facts WHERE project_id = ? GROUP BY fact_key, status ORDER BY fact_key`, [P]);
  await q('absorbedEvents24h', `SELECT COUNT(*) AS n, MAX(created_at) AS latest FROM cash_events WHERE project_id = ? AND kind = ? AND created_at >= ?`, [P, 'INDUSTRY_FACT_ABSORBED', new Date(Date.now() - 24 * 3600_000).toISOString()]);
  try {
    const { unfiledConstructedRoundClaims } = await import('../server/repos/research.ts');
    const rows = await unfiledConstructedRoundClaims(P, '', 200);
    show('unfiledConstructed', { n: rows.length, oppizi: rows.filter((r) => /Oppizi/.test(r.claim.claim)).map((r) => ({ id: r.claim.id, bucket: r.bucketId })), buckets: [...new Set(rows.map((r) => r.bucketId))].slice(0, 20) });
    const { backfillCandidates } = await import('../server/services/industry/expand.ts');
    const pool = await backfillCandidates(P);
    const mine = pool.decisions.filter((d) => d.source === 'CONSTRUCTED_ROUND');
    const reasons: Record<string, number> = {};
    for (const d of mine) reasons[d.reason ?? 'CANDIDATE'] = (reasons[d.reason ?? 'CANDIDATE'] ?? 0) + 1;
    show('constructedDecisions', { total: pool.decisions.length, constructed: mine.length, reasons, oppizi: mine.filter((d) => rows.some((r) => r.claim.id === d.claimId && /Oppizi/.test(r.claim.claim))).map((d) => ({ claimId: d.claimId, reason: d.reason, amount: d.candidate?.amount ?? null })) });
    const bySource: Record<string, { cand: number; skip: number }> = {};
    for (const d of pool.decisions) { const b = (bySource[d.source] ??= { cand: 0, skip: 0 }); if (d.candidate) b.cand += 1; else b.skip += 1; }
    show('decisionsBySource', bySource);
  } catch (error) {
    show('backfill ERROR', message(error));
  }
  await q('workItems', `SELECT id, work_type, state, attempt_count, max_attempts, failure_category, lease_expires_at, updated_at, completed_at, orchestration_id FROM work_items WHERE id LIKE ? OR id LIKE ? OR id LIKE ?`, ['wki_4d8c4039%', 'wki_89af110a%', 'wki_0242ea8f%']);
  const wi = (await db.all(`SELECT DISTINCT orchestration_id FROM work_items WHERE (id LIKE ? OR id LIKE ? OR id LIKE ?) AND orchestration_id IS NOT NULL`, ['wki_4d8c4039%', 'wki_89af110a%', 'wki_0242ea8f%'])) as { orchestration_id: string }[];
  for (const { orchestration_id: o } of wi) {
    await q(`wiOrch ${o}`, `SELECT * FROM research_orchestrations WHERE id = ?`, [o]);
    await q(`wiOrchItems ${o}`, `SELECT id, work_type, state, attempt_count, failure_category, created_at, updated_at FROM work_items WHERE orchestration_id = ? AND created_at >= ? ORDER BY created_at`, [o, '2026-11-17T00:00:00Z']);
    const ms = await q(`wiMissions ${o}`, `SELECT * FROM russell_missions WHERE orchestration_id = ?`, [o]);
    for (const m of ms) await q(`wiRounds ${String(m.candidate_id)}`, `SELECT * FROM cash_discovery_rounds WHERE candidate_id = ?`, [String(m.candidate_id)]);
  }
}

async function main(): Promise<void> {
  await initDatabase();
  try {
    await traceB1d();
    console.log('GOALS: OK');
    if (process.argv.length > 0) return;
    const lines = await census();
    console.log(`CENSUS at ${new Date().toISOString()} revision ${process.env.BRAIN_REVISION ?? '<unstamped>'}`);
    for (const one of lines) console.log(`CENSUS ${one.layer.padEnd(9)} ${one.key.padEnd(28)} ${one.value === null ? '-' : String(one.value).padStart(8)}  ${one.label}${one.note ? ` — ${one.note}` : ''}`);
    if (process.argv.includes('--json')) console.log(`CENSUS_JSON ${JSON.stringify(lines)}`);
    try {
      const diag = await diagnose();
      for (const one of diag) for (const line of diagLines(one)) console.log(line);
      // This process's own reading, not the server's: the server keeps its pressure in memory only.
      const { databasePressure } = await import('../server/db/pressure.ts');
      const pressure = databasePressure();
      console.log(`DIAG pressure (census process only) ${pressure.state} — ${pressure.reason}`);
      if (process.argv.includes('--json')) console.log(`DIAG_JSON ${JSON.stringify(diag)}`);
    } catch (error) {
      console.log(`DIAG UNMEASURED — ${message(error)}`);
    }
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
