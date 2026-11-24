/**
 * The commercial knowledge pass (§122), run by the Russell tick: discover the
 * newest public datasets, read what is due, understand it, apply it to the
 * plans that will read it, and let the GPU interpret what is still unread.
 *
 * One pass at a time in this process (a pass reads tens of megabytes); the
 * tick starts it and does not wait for it, so the tick's other passes are
 * never held behind a download. Every step is bounded and records what it did.
 */
import { getDb } from '../../db/database.ts';
import { sectorOf } from '../../domain/commercialKnowledge.ts';
import {
  currentFactsFor,
  finishPassRow,
  startPassRow,
  getIndustry,
  listDueSources,
  listSources,
  recordAcquisition,
  recordInterpretation,
  recordSourceRead,
  registerSource,
  supersedeSourcesOf,
  writeFacts,
} from '../../repos/commercialKnowledge.ts';
import {
  FAMILIES,
  PARSERS,
  conditionalBytes,
  datasetText,
  discoverCandidatePrograms,
  httpBytesTransport,
  httpText,
  nextDueAfter,
  sourceFor,
  type BytesTransport,
  type TextFetch,
} from './acquire.ts';
import { checkProgramAgreement, deriveIndustryEconomics, recordIndustryTitles } from './comprehend.ts';
import { applyKnowledgeToProject, projectsWithLiveGoals } from './apply.ts';
import { interpretIndustry, modelAvailable, type ModelDeps } from './interpret.ts';
import { httpJson, newestSecYear, readSecYear, type JsonFetch } from './sec.ts';
import type { KnowledgeSourceRow } from '../../domain/types.ts';

export interface KnowledgeDeps extends ModelDeps {
  transport?: BytesTransport;
  getText?: TextFetch;
  getJson?: JsonFetch;
  now?: () => Date;
}

export interface PassReport {
  discovered: string[];
  candidates: string[];
  reads: { source: string; outcome: string; facts: number; error?: string }[];
  derived: { written: number; unchanged: number } | null;
  agreement: { compared: number; reconciled: number; recorded: number } | null;
  applied: { projectId: string; linked: number; filed: number; superseded: number; contradictions: number; questionsResolved: number }[];
  interpreted: string[];
  errors: string[];
}

const DISCOVERY_EVERY_MS = 24 * 3_600_000;
let lastDiscoveryAt = 0;

/** Find each family's newest vintage, register it, and stop reading the one it replaces. */
export async function discoverSources(deps: KnowledgeDeps = {}, force = false): Promise<{ discovered: string[]; candidates: string[]; errors: string[] }> {
  const now = (deps.now ?? (() => new Date()))();
  const out = { discovered: [] as string[], candidates: [] as string[], errors: [] as string[] };
  if (!force && now.getTime() - lastDiscoveryAt < DISCOVERY_EVERY_MS) return out;
  lastDiscoveryAt = now.getTime();
  const get = deps.getText ?? httpText;
  const known = await listSources();
  const receiptsYear = known.filter((s) => s.family === 'SUSB').map((s) => s.period).sort().pop() ?? null;
  // SUSB first: the receipts year decides which CBP vintage is the comparable one.
  for (const family of FAMILIES) {
    try {
      const found = await family.discover(get, { receiptsYear: family.family === 'CBP_CENSUS_YEAR' ? (receiptsYear ?? (await latestReceiptsYear())) : receiptsYear });
      if (!found) continue;
      const def = sourceFor(family, found, known.length === 0 ? 'CATALOG' : 'DISCOVERED');
      if (await registerSource(def, now.toISOString())) out.discovered.push(def.sourceKey);
      await supersedeSourcesOf(family.family, def.sourceKey, now.toISOString());
    } catch (error) {
      out.errors.push(`${family.family}: ${String((error as Error)?.message ?? error).slice(0, 200)}`);
    }
  }
  try {
    const year = await newestSecYear(deps.getJson ?? httpJson, now);
    if (year) {
      const key = `sec_xbrl-${year}`;
      const added = await registerSource({
        sourceKey: key,
        family: 'SEC_XBRL',
        title: `SEC XBRL frames CY${year}: public companies' revenue, gross and operating profit, receivables, inventory and fixed assets`,
        publisher: 'U.S. Securities and Exchange Commission (EDGAR XBRL frames)',
        url: `https://data.sec.gov/api/xbrl/frames/us-gaap/Revenues/USD/CY${year}.json`,
        period: String(year),
        format: 'JSON',
        origin: known.length === 0 ? 'CATALOG' : 'DISCOVERED',
        discoveredFrom: 'https://data.sec.gov/api/xbrl/frames/',
        valueReason: 'margins, the cash cycle and capital intensity by sector, from companies\' own audited filings: what the business counts cannot say',
      }, now.toISOString());
      if (added) out.discovered.push(key);
      await supersedeSourcesOf('SEC_XBRL', key, now.toISOString());
    }
  } catch (error) {
    out.errors.push(`SEC_XBRL: ${String((error as Error)?.message ?? error).slice(0, 200)}`);
  }
  try {
    const keys = new Set((await listSources()).map((s) => s.source_key));
    for (const def of await discoverCandidatePrograms(get, keys, Math.floor(now.getTime() / 3_600_000))) {
      if (await registerSource(def, now.toISOString())) out.candidates.push(def.sourceKey);
    }
  } catch (error) {
    out.errors.push(`candidate programs: ${String((error as Error)?.message ?? error).slice(0, 200)}`);
  }
  return out;
}

async function latestReceiptsYear(): Promise<string | null> {
  const row = await getDb().get<{ period: string | null }>(`SELECT MAX(period) AS period FROM knowledge_sources WHERE family = 'SUSB'`);
  return row?.period ?? null;
}

/** Read one source: a conditional fetch, a deterministic parse, and the facts it changed. */
export async function readSource(source: KnowledgeSourceRow, deps: KnowledgeDeps = {}): Promise<{ outcome: 'MODIFIED' | 'NOT_MODIFIED' | 'FAILED'; facts: number; error?: string }> {
  const now = (deps.now ?? (() => new Date()))();
  const started = now.toISOString();
  const parser = PARSERS[source.family];
  if (!parser && source.family !== 'SEC_XBRL') return { outcome: 'FAILED', facts: 0, error: `no reader for ${source.family}` };
  try {
    if (source.family === 'SEC_XBRL') {
      const sec = await readSecYear(deps.getJson ?? httpJson, { sourceId: source.id, sourceTitle: source.title, sourceUrl: source.url, year: Number(source.period), acquiredAt: started });
      if (sec.facts.length === 0) throw new Error('the frames held no company that the EDGAR index classifies');
      const same = source.content_hash === sec.contentHash;
      const written = same ? { written: 0, unchanged: sec.facts.length } : await writeFacts(sec.facts);
      await recordAcquisition({ source_id: source.id, started_at: started, finished_at: new Date().toISOString(), outcome: same ? 'NOT_MODIFIED' : 'MODIFIED', http_status: 200, content_hash: sec.contentHash, bytes: 0, rows_read: sec.rows, facts_written: written.written, facts_unchanged: written.unchanged, error: null });
      await recordSourceRead({ source, ok: true, contentHash: sec.contentHash, nextDueAt: nextDueAfter(now, true, 0) });
      return { outcome: same ? 'NOT_MODIFIED' : 'MODIFIED', facts: written.written };
    }
    if (!parser) throw new Error(`no reader for ${source.family}`);
    const read = await conditionalBytes(deps.transport ?? httpBytesTransport, source.url, { etag: source.etag, lastModified: source.last_modified, contentHash: source.content_hash });
    if (read.status === 'NOT_MODIFIED') {
      await recordAcquisition({ source_id: source.id, started_at: started, finished_at: new Date().toISOString(), outcome: 'NOT_MODIFIED', http_status: read.httpStatus, content_hash: read.validators.contentHash ?? null, bytes: 0, rows_read: 0, facts_written: 0, facts_unchanged: 0, error: null });
      await recordSourceRead({ source, ok: true, etag: read.validators.etag, lastModified: read.validators.lastModified, contentHash: read.validators.contentHash, nextDueAt: nextDueAfter(now, true, 0) });
      return { outcome: 'NOT_MODIFIED', facts: 0 };
    }
    const text = await datasetText(source.url, read.body);
    const parsed = parser(text, { sourceId: source.id, acquisitionId: null, sourceTitle: source.title, sourceUrl: source.url, family: source.family, period: source.period, acquiredAt: started });
    if (parsed.titles.length > 0) await recordIndustryTitles(parsed.titles);
    const written = await writeFacts(parsed.facts);
    await recordAcquisition({ source_id: source.id, started_at: started, finished_at: new Date().toISOString(), outcome: 'MODIFIED', http_status: read.httpStatus, content_hash: read.contentHash, bytes: read.body.byteLength, rows_read: parsed.rows, facts_written: written.written, facts_unchanged: written.unchanged, error: null });
    // The validators land only after the facts: a read that died before writing them is read again.
    await recordSourceRead({ source, ok: true, etag: read.validators.etag, lastModified: read.validators.lastModified, contentHash: read.contentHash, nextDueAt: nextDueAfter(now, true, 0) });
    return { outcome: 'MODIFIED', facts: written.written };
  } catch (error) {
    const message = String((error as Error)?.message ?? error).slice(0, 400);
    await recordAcquisition({ source_id: source.id, started_at: started, finished_at: new Date().toISOString(), outcome: 'FAILED', http_status: null, content_hash: null, bytes: 0, rows_read: 0, facts_written: 0, facts_unchanged: 0, error: message });
    await recordSourceRead({ source, ok: false, error: message, nextDueAt: nextDueAfter(now, false, source.consecutive_failures) });
    return { outcome: 'FAILED', facts: 0, error: message };
  }
}

/** The order sources are read in: receipts first (its titles name the industries), then the counts. */
const FAMILY_ORDER = ['SUSB', 'SUSB_RECEIPTS', 'CBP', 'NES', 'SEC_XBRL', 'CBP_CENSUS_YEAR', 'CBP_STATE'];

/** Industries a live plan reads first, then the rest of the economy, deepest-first among the unread. */
async function interpretationOrder(limit: number): Promise<string[]> {
  const linked = await getDb().all<{ naics: string }>(`SELECT naics FROM knowledge_links WHERE method <> 'NONE'`);
  const wanted = new Set<string>();
  for (const row of linked) for (const code of JSON.parse(row.naics) as string[]) wanted.add(code);
  const unread = await getDb().all<{ naics: string }>(
    `SELECT naics FROM knowledge_industries WHERE interpreted_at IS NULL AND naics_level >= 4 ORDER BY naics_level ASC, naics ASC LIMIT 500`,
  );
  const order = [...[...wanted].filter((c) => unread.some((u) => u.naics === c)), ...unread.map((u) => u.naics).filter((c) => !wanted.has(c))];
  return order.slice(0, limit);
}

/** Ask the GPU to read up to `limit` industries' economics. */
export async function interpretIndustries(limit: number, deps: KnowledgeDeps = {}): Promise<{ interpreted: string[]; errors: string[] }> {
  const out = { interpreted: [] as string[], errors: [] as string[] };
  if (limit <= 0 || !modelAvailable(deps)) return out;
  for (const naics of await interpretationOrder(limit)) {
    const industry = await getIndustry(naics);
    if (!industry) continue;
    const sector = sectorOf(naics);
    const facts = (await currentFactsFor(sector === naics ? [naics] : [naics, sector], ['US'])).filter(
      (f) => (f.epistemic === 'FACT' || f.epistemic === 'ESTIMATE') && (f.naics === naics || f.size_class === 'PUBLIC'),
    );
    if (facts.length < 3) continue;
    const answer = await interpretIndustry(industry.label, naics, facts, deps);
    if (!answer.value) {
      out.errors.push(`${naics}: ${answer.error}`);
      continue;
    }
    const v = answer.value;
    const ok = await recordInterpretation({
      naics,
      customer: v.customer,
      mechanisms: JSON.stringify({ revenue: v.revenue, mechanisms: v.mechanisms }),
      interpretation: v.interpretation,
      principles: JSON.stringify(v.principles),
      requirements: JSON.stringify(v.requirements),
      unknowns: JSON.stringify(v.unknowns),
      model: answer.model,
      servedBy: answer.servedBy,
      staleBefore: new Date(Date.now() - 180 * 86_400_000).toISOString(),
    });
    if (ok) out.interpreted.push(naics);
  }
  return out;
}

/** One whole pass. Bounded: at most `maxReads` dataset reads and `gpuCalls` model calls. */
export async function runKnowledgePass(options: { maxReads?: number; gpuCalls?: number; forceDiscovery?: boolean } = {}, deps: KnowledgeDeps = {}): Promise<PassReport> {
  const report: PassReport = { discovered: [], candidates: [], reads: [], derived: null, agreement: null, applied: [], interpreted: [], errors: [] };
  const discovery = await discoverSources(deps, options.forceDiscovery ?? false);
  report.discovered = discovery.discovered;
  report.candidates = discovery.candidates;
  report.errors.push(...discovery.errors);

  const now = (deps.now ?? (() => new Date()))().toISOString();
  const due = (await listDueSources(now, 50)).sort((a, b) => FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family));
  let changed = false;
  for (const source of due.slice(0, options.maxReads ?? 3)) {
    const read = await readSource(source, deps);
    report.reads.push({ source: source.source_key, outcome: read.outcome, facts: read.facts, ...(read.error ? { error: read.error } : {}) });
    if (read.outcome === 'MODIFIED') changed = true;
  }

  const derivedCount = await getDb().get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM knowledge_facts WHERE quality = 'DERIVED'`);
  if (changed || Number(derivedCount?.n ?? 0) === 0) {
    const derived = await deriveIndustryEconomics();
    report.derived = { written: derived.written, unchanged: derived.unchanged };
    report.agreement = await checkProgramAgreement();
  }

  // Half the pass's GPU calls may classify buyers the words did not match; the rest, and whatever that left, interpret industries.
  const gpuCalls = Math.max(0, options.gpuCalls ?? 4);
  const linkCalls = Math.floor(gpuCalls / 2);
  const budget = { left: linkCalls };
  for (const { projectId, goalTitles } of await projectsWithLiveGoals()) {
    try {
      const applied = await applyKnowledgeToProject(projectId, goalTitles.join(' '), { modelBudget: budget, deps });
      report.applied.push({ projectId, linked: applied.linked, filed: applied.filed, superseded: applied.superseded, contradictions: applied.contradictions, questionsResolved: applied.questionsResolved });
    } catch (error) {
      report.errors.push(`apply ${projectId}: ${String((error as Error)?.message ?? error).slice(0, 200)}`);
    }
  }

  const interpreted = await interpretIndustries(gpuCalls - (linkCalls - budget.left), deps);
  report.interpreted = interpreted.interpreted;
  report.errors.push(...interpreted.errors);
  return report;
}

/* ------------------------------------------------------------- its own clock */

const PASS_EVERY_MS = 15 * 60_000;
let running: Promise<void> | null = null;
let lastStartedAt = 0;

/**
 * Start a pass if none is running and the last started long enough ago.
 * Returns at once; the pass runs beside everything else and records itself
 * in `knowledge_passes` — started, finished, and what it did or why it failed.
 */
export function startKnowledgePassIfDue(onError: (error: unknown) => void, nowMs = Date.now()): boolean {
  if ((process.env['BRAIN_KNOWLEDGE'] ?? '').trim().toLowerCase() === 'off') return false;
  if (running || nowMs - lastStartedAt < PASS_EVERY_MS) return false;
  lastStartedAt = nowMs;
  running = (async () => {
    const id = await startPassRow();
    try {
      const report = await runKnowledgePass();
      await finishPassRow(id, 'DONE', report);
      console.log(
        `[brain] commercial knowledge pass: ${report.reads.map((r) => `${r.source} ${r.outcome}${r.facts ? ` +${r.facts}` : ''}`).join(', ') || 'nothing due'}; ` +
          `discovered ${report.discovered.length}, applied ${report.applied.reduce((t, a) => t + a.filed + a.superseded, 0)} fact(s), interpreted ${report.interpreted.length}` +
          (report.errors.length ? `; ${report.errors.length} error(s): ${report.errors.slice(0, 3).join(' | ')}` : ''),
      );
    } catch (error) {
      await finishPassRow(id, 'FAILED', { error: String((error as Error)?.message ?? error).slice(0, 1000) }).catch(() => undefined);
      throw error;
    }
  })()
    .catch(onError)
    .finally(() => {
      running = null;
    });
  return true;
}

let timer: NodeJS.Timeout | null = null;

/**
 * The knowledge pass's own clock (§90: independent work does not wait for
 * unrelated work). It rode the Russell tick at first, and on production the
 * tick's length and its shedding kept it from ever starting. Checked every
 * minute; a pass starts at most every fifteen, never while the database is
 * shedding optional work (§63).
 */
export function startCommercialKnowledgeLoop(isShedding: () => boolean, everyMs = 60_000): void {
  if (timer) return;
  const tick = () => {
    if (isShedding()) return;
    startKnowledgePassIfDue((error: unknown) => console.warn(`[brain] commercial knowledge pass failed: ${String((error as Error)?.message ?? error).slice(0, 300)}`));
  };
  tick();
  timer = setInterval(tick, everyMs);
  timer.unref?.();
}
