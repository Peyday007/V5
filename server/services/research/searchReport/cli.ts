/**
 * The terminal for Brain's search intelligence: the live report, and a
 * comparison of methods on shared data.
 *
 *   npx tsx server/services/research/searchReport/cli.ts report  --project P [--since ISO] [--json]
 *   npx tsx server/services/research/searchReport/cli.ts methods --project P
 *   npx tsx server/services/research/searchReport/cli.ts compare --project P --subject S --file results.json
 *
 * Invariant 35: there is no administration page; reaching the shell is the
 * authentication. Everything printed is derived from rows at the moment it is
 * asked — the report from `search_methods` and `search_method_runs` (with the
 * cash buckets' downstream outcomes from `discoveryYield` attached under the
 * same method keys), `methods` from each method's runs through
 * `decideMethod`, so a paused or revise-flagged method says so and why.
 * Nothing here writes.
 *
 * `compare` reads `{ "items": [...], "results": { "<methodId>": { "surfaced":
 * [...], "confirmed": [...], "rejected": [...] } } }` and prints the ranking
 * `compareMethods` derives, or its refusal.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { closeDatabase, initDatabase } from '../../../db/database.ts';
import { listMethodRuns, listSearchMethods } from '../../../repos/searchMethods.ts';
import type { SearchReader } from '../../../domain/searchIntelligence.ts';
import { discoveryYield } from '../../cash/discoveryYield.ts';
import { decideMethod, type MethodDecision } from '../searchFailures/classify.ts';
import { compareMethods, type CompareResult, type MethodResult } from '../searchMethods/compare.ts';
import { buildSearchReport, renderSearchReport, type SearchReport } from './report.ts';

const USAGE = [
  'usage: cli.ts report  --project P [--since ISO] [--json]',
  '       cli.ts methods --project P',
  '       cli.ts compare --project P --subject S --file results.json',
].join('\n');

export interface SearchCliDeps {
  report?: (reader: SearchReader, opts: { since: string | null; downstream: Map<string, { useful: number; qualified: number; duplicates: number }> }) => Promise<SearchReport>;
  downstream?: (projectId: string) => Promise<Map<string, { useful: number; qualified: number; duplicates: number }>>;
  decisions?: (reader: SearchReader, now: string) => Promise<{ methodKey: string; trustState: string; decision: MethodDecision }[]>;
  compare?: (reader: SearchReader, input: { subjectId: string; items: string[]; results: Record<string, MethodResult> }) => Promise<CompareResult>;
  readFile?: (path: string) => string;
  now?: () => string;
}

function flag(argv: readonly string[], name: string): string | null {
  const at = argv.indexOf(`--${name}`);
  const value = at >= 0 ? argv[at + 1] : undefined;
  return value && !value.startsWith('--') ? value : null;
}

async function cashDownstream(projectId: string): Promise<Map<string, { useful: number; qualified: number; duplicates: number }>> {
  const reading = await discoveryYield(projectId);
  return new Map(reading.byMethod.map((one) => [one.key, { useful: one.useful, qualified: one.qualified, duplicates: one.duplicates }] as const));
}

/** Every method the reader can see, and what its runs say it may do now. */
export async function methodDecisions(reader: SearchReader, now: string): Promise<{ methodKey: string; trustState: string; decision: MethodDecision }[]> {
  const out: { methodKey: string; trustState: string; decision: MethodDecision }[] = [];
  for (const method of await listSearchMethods(reader)) {
    out.push({ methodKey: method.methodKey, trustState: method.trustState, decision: decideMethod(await listMethodRuns(reader, method.id), now) });
  }
  return out;
}

export function renderDecisions(rows: readonly { methodKey: string; trustState: string; decision: MethodDecision }[]): string {
  if (rows.length === 0) return 'no search methods recorded for this project yet';
  return rows
    .map((row) => {
      const d = row.decision;
      const when = d.action === 'PAUSE' && d.retryAt ? ` until ${d.retryAt}` : '';
      return `${row.methodKey} ${row.trustState} ${d.action}${when}${d.cause ? ` [${d.cause}]` : ''} — ${d.reason} (${d.failedInARow} failed in a row)`;
    })
    .join('\n');
}

/** Runs one command; returns the exit code and what to print. Never throws for a usage error. */
export async function runSearchCli(argv: readonly string[], deps: SearchCliDeps = {}): Promise<{ code: number; out: string }> {
  const [command] = argv;
  const project = flag(argv, 'project');
  if (!command || !['report', 'methods', 'compare'].includes(command) || !project) return { code: 2, out: USAGE };
  const reader: SearchReader = { projectIds: [project], userId: null };
  const now = (deps.now ?? (() => new Date().toISOString()))();

  if (command === 'report') {
    const downstream = await (deps.downstream ?? cashDownstream)(project);
    const report = await (deps.report ?? ((r, o) => buildSearchReport(r, { now, since: o.since, downstream: o.downstream })))(reader, {
      since: flag(argv, 'since'),
      downstream,
    });
    return { code: 0, out: argv.includes('--json') ? JSON.stringify(report, null, 2) : renderSearchReport(report) };
  }

  if (command === 'methods') {
    return { code: 0, out: renderDecisions(await (deps.decisions ?? methodDecisions)(reader, now)) };
  }

  const subject = flag(argv, 'subject');
  const file = flag(argv, 'file');
  if (!subject || !file) return { code: 2, out: USAGE };
  let parsed: { items?: unknown; results?: unknown };
  try {
    parsed = JSON.parse((deps.readFile ?? ((p: string) => readFileSync(p, 'utf8')))(file)) as typeof parsed;
  } catch {
    return { code: 2, out: `${file} is not readable JSON` };
  }
  const items = Array.isArray(parsed.items) ? parsed.items.filter((x): x is string => typeof x === 'string') : [];
  const results = (parsed.results && typeof parsed.results === 'object' ? parsed.results : {}) as Record<string, MethodResult>;
  const compared = await (deps.compare ?? compareMethods)(reader, { subjectId: subject, items, results });
  if (!compared.ok) return { code: 1, out: `not compared: ${compared.reason}` };
  const c = compared.comparison;
  return {
    code: 0,
    out: [
      `subject ${c.subjectId}, ${c.items} shared item(s): ${c.decidedBy}`,
      ...c.ranking.map((r, i) => `  ${i + 1}. ${r.methodId} precision ${r.metrics.precision === null ? 'not yet' : r.metrics.precision.toFixed(2)}`),
    ].join('\n'),
  };
}

async function main(): Promise<void> {
  await initDatabase();
  try {
    const { code, out } = await runSearchCli(process.argv.slice(2));
    (code === 0 ? process.stdout : process.stderr).write(`${out}\n`);
    process.exitCode = code;
  } finally {
    await closeDatabase();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
