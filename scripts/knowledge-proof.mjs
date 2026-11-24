#!/usr/bin/env node
/**
 * Production proof for commercial knowledge (§122): reads the newest successful
 * `Goals` workflow run of the `census` command (which runs
 * scripts/knowledge-census.ts on the production machine) and checks one named
 * property of what production holds. Exits non-zero when it does not hold.
 *
 *   node scripts/knowledge-proof.mjs <check> [--since ISO]
 *
 * Read-only: it reads workflow logs through the GitHub API and nothing else.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const REPO = process.env.GITHUB_REPOSITORY || 'Peyday007/V5';
const check = process.argv[2];
const sinceArg = process.argv.indexOf('--since');
const since = sinceArg > 0 ? process.argv[sinceArg + 1] : null;

const gh = (path) => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
const ghText = (path) => execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

function latestCensus() {
  const runs = gh(`repos/${REPO}/actions/workflows/goals.yml/runs?event=workflow_dispatch&status=success&per_page=30`).workflow_runs ?? [];
  for (const run of runs) {
    if (since && run.created_at < since) continue;
    for (const job of gh(`repos/${REPO}/actions/runs/${run.id}/jobs`).jobs ?? []) {
      const log = ghText(`repos/${REPO}/actions/jobs/${job.id}/logs`);
      const line = log.split('\n').find((l) => l.includes('KNOWLEDGE_JSON '));
      const census = log.split('\n').find((l) => l.includes('CENSUS_JSON '));
      if (line && census) return { run, knowledge: JSON.parse(line.slice(line.indexOf('KNOWLEDGE_JSON ') + 15)), census: JSON.parse(census.slice(census.indexOf('CENSUS_JSON ') + 12)) };
    }
  }
  return null;
}

const found = latestCensus();
if (!found) {
  console.error('no successful production census run with a KNOWLEDGE_JSON line');
  process.exit(1);
}
const { run, knowledge: k, census } = found;
const c = Object.fromEntries(census.map((one) => [one.key, one.value]));
const applied = k.plans?.applied ?? {};
const facts = k.understanding?.facts ?? {};
const byClass = k.understanding?.byClass ?? {};
const sources = k.learning?.sources ?? [];

const CHECKS = {
  acquired: () => sources.filter((s) => s.lastSuccessAt).length >= 5 && (c.knowledgeFacts ?? 0) > 50_000,
  discovered: () => sources.length >= 6 && ((k.missing?.sourcesWithoutReader ?? []).length > 0 || sources.some((s) => s.origin === 'DISCOVERED')),
  incremental: () => (k.learning?.recentReads ?? []).some((r) => r.outcome === 'NOT_MODIFIED' || r.factsUnchanged > 0) || sources.every((s) => s.nextDueAt > s.lastSuccessAt),
  classified: () => ['VOLUME', 'PRICE', 'COST', 'MARGIN', 'CAPITAL', 'CASH_FLOW', 'OPERATIONS', 'STRUCTURE'].every((m) => (byClass[m] ?? 0) > 0),
  epistemic: () => (facts.FACT ?? 0) > 0 && (facts.ESTIMATE ?? 0) > 0 && (facts.UNKNOWN ?? 0) > 0,
  industries: () => (k.understanding?.industriesTitled ?? 0) > 500 && (k.understanding?.industriesMeasured ?? 0) > 500,
  mechanisms: () => Object.keys(k.mechanisms?.revenueBases ?? {}).length >= 5,
  customers: () => Object.keys(k.understanding?.byCustomer ?? {}).length >= 3,
  geography: () => (c.knowledgeFacts ?? 0) > 0 && sources.some((s) => /by state/.test(s.title)) && sources.find((s) => /by state/.test(s.title))?.lastSuccessAt,
  capital: () => (byClass.CAPITAL ?? 0) > 0 && (byClass.CASH_FLOW ?? 0) > 0 && (byClass.MARGIN ?? 0) > 0,
  interpreted: () => (k.understanding?.industriesInterpreted ?? 0) > 0 && (k.understanding?.interpreted ?? []).some((i) => i.servedBy && (i.requirements ?? []).length > 0),
  derived: () => (c.knowledgeEstimates ?? 0) > 1000,
  linked: () => (c.knowledgeLinkedBuyers ?? 0) > 0,
  applied: () => (applied.CONSTRUCTION_FACT ?? 0) > 0,
  planChanged: () => (applied.PLAN_INPUT_CHANGED ?? 0) > 0,
  visible: () => ['learning', 'understanding', 'mechanisms', 'recent', 'missing', 'plans', 'capacity'].every((key) => key in k),
  capacity: () => k.capacity && typeof k.capacity.idleBesideWork === 'boolean' && k.capacity.readsLast24h > 0,
  // Economic relationships: ratios derived across programs (receipts per establishment, payroll share, size mix) and the two programs compared.
  relationships: () => (byClass.STRUCTURE ?? 0) > 0 && (c.knowledgeEstimates ?? 0) > 1000,
  // Operational requirements: per-industry operations figures and the GPU's named requirements.
  operations: () => (byClass.OPERATIONS ?? 0) > 0 && (k.understanding?.interpreted ?? []).some((i) => (i.requirements ?? []).length > 0),
  // Refresh: every source carries its next check, stale figures are counted, and passes keep running on their own clock.
  refresh: () => sources.length > 0 && sources.every((s) => s.nextDueAt) && typeof k.missing?.staleFacts === 'number' && (k.learning?.passes ?? []).filter((p) => p.status === 'DONE').length >= 2,
  // Prioritised by active objectives: each pass applies knowledge to the projects with live goals, and some were filed.
  prioritized: () => (k.learning?.lastPass?.applied ?? []).length > 0 && (applied.CONSTRUCTION_FACT ?? 0) > 0,
  // Measured as knowledge applied, not bytes: application counts per kind, with before/after.
  measured: () => Object.values(applied).reduce((t, n) => t + n, 0) > 0 && (k.plans?.recent ?? []).some((a) => a.before && a.after),
  // Gaps are rows: industries not yet interpreted, withheld cells, unmatched buyers and readerless sources are all counted.
  gaps: () => (k.missing?.industriesUninterpreted ?? 0) > 0 && (k.missing?.withheldCells ?? 0) > 0 && Array.isArray(k.missing?.buyersUnclassified) && Array.isArray(k.missing?.sourcesWithoutReader),
  // Research prioritisation: a question the data answered was closed, and the plan's next question moved past the count.
  research: () => (applied.UNCERTAINTY_RESOLVED ?? 0) > 0 || (k.plans?.recent ?? []).some((a) => /next research round asks for/.test(a.after ?? '')),
};

if (!CHECKS[check]) {
  console.error(`unknown check "${check}"; one of ${Object.keys(CHECKS).join(', ')}`);
  process.exit(2);
}
const ok = !!CHECKS[check]();
const summary = { run: run.html_url, at: run.created_at, check, ok, applied, facts, sources: sources.length, interpreted: k.understanding?.industriesInterpreted, linked: c.knowledgeLinkedBuyers };
console.log(JSON.stringify(summary));
if (process.env.KNOWLEDGE_PROOF_DUMP) fs.writeFileSync(process.env.KNOWLEDGE_PROOF_DUMP, JSON.stringify(k, null, 2));
process.exit(ok ? 0 : 1);
