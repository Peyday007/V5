/**
 * What Brain has learned from public commercial data, and what it did with it
 * (§121) — derived on the read path from the knowledge rows, stored nowhere.
 *
 * Public data is Brain's (§31); what it was applied to is a project's, so the
 * applications, links and project-scoped contradictions are narrowed to the
 * projects the reader may read (§34). Answers the seven questions the
 * Command Center asks: what Brain is learning, which industries it
 * understands, which mechanisms are mapped, what arrived recently, what is
 * missing, how plans improved, and whether productive capacity is used.
 */
import { getDb } from '../../db/database.ts';
import {
  applicationCounts,
  contradictionCounts,
  factCounts,
  factsAddedSince,
  industryCounts,
  listApplications,
  listRecentAcquisitions,
  listSources,
  recentContradictions,
  recentFacts,
  recentlyInterpreted,
  staleFactCount,
} from '../../repos/commercialKnowledge.ts';
import { lastKnowledgePass } from './pipeline.ts';
import { modelAvailable } from './interpret.ts';
import { METRICS } from '../../domain/commercialKnowledge.ts';

const parse = <T>(text: string | null, fallback: T): T => {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

export async function knowledgeView(readable: readonly string[], now = new Date()): Promise<Record<string, unknown>> {
  const nowIso = now.toISOString();
  const dayAgo = new Date(now.getTime() - 86_400_000).toISOString();
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const projects = new Set(readable);

  const sources = await listSources();
  const acquisitions = await listRecentAcquisitions(20);
  const facts = await factCounts();
  const industries = await industryCounts();
  const interpreted = await recentlyInterpreted(10);

  // Mechanisms mapped: how many industries carry each revenue basis and mechanism.
  const mechRows = await getDb().all<{ mechanisms: string; classified_by: string }>('SELECT mechanisms, classified_by FROM knowledge_industries');
  const revenue: Record<string, number> = {};
  const mechanisms: Record<string, number> = {};
  for (const row of mechRows) {
    const m = parse<{ revenue?: string[]; mechanisms?: string[] }>(row.mechanisms, {});
    for (const r of m.revenue ?? []) revenue[r] = (revenue[r] ?? 0) + 1;
    for (const r of m.mechanisms ?? []) mechanisms[r] = (mechanisms[r] ?? 0) + 1;
  }

  // Industries understood: those with measured economics (a derived figure) and those the GPU also read.
  const measured = await getDb().get<{ n: number | string }>(`SELECT COUNT(DISTINCT naics) AS n FROM knowledge_facts WHERE quality = 'DERIVED' AND naics_level >= 2`);

  const links = (await getDb().all<{ project_id: string; node_name: string; naics: string; method: string; rationale: string; geo_code: string; size_class: string }>(
    'SELECT project_id, node_name, naics, method, rationale, geo_code, size_class FROM knowledge_links',
  )).filter((l) => projects.has(l.project_id));
  const unmatched = links.filter((l) => l.method === 'NONE');
  const applications = (await listApplications(200)).filter((a) => projects.has(a.project_id));
  const counts = await applicationCounts();
  const contradictions = (await recentContradictions(20)).filter((c) => !c.project_id || projects.has(c.project_id));
  const unknownCells = facts.filter((f) => f.epistemic === 'UNKNOWN').reduce((t, f) => t + f.n, 0);
  const candidates = sources.filter((s) => s.status === 'CANDIDATE');
  const due = sources.filter((s) => (s.status === 'ACTIVE' || s.status === 'FAILING') && s.next_due_at <= nowIso);
  const readsToday = acquisitions.filter((a) => a.started_at >= dayAgo);
  const interpretedToday = await getDb().get<{ n: number | string }>('SELECT COUNT(*) AS n FROM knowledge_industries WHERE interpreted_at >= ?', [dayAgo]);
  const gpu = modelAvailable();
  const uninterpreted = industries.total - industries.interpreted;
  const pass = lastKnowledgePass();

  return {
    readAt: nowIso,
    learning: {
      lastPass: pass,
      sources: sources
        .filter((s) => s.status !== 'CANDIDATE')
        .map((s) => ({ key: s.source_key, title: s.title, publisher: s.publisher, period: s.period, status: s.status, origin: s.origin, url: s.url, lastSuccessAt: s.last_success_at, nextDueAt: s.next_due_at, failures: s.consecutive_failures, lastError: s.last_error, why: s.value_reason })),
      recentReads: acquisitions.map((a) => ({ source: a.source_key, at: a.started_at, outcome: a.outcome, bytes: a.bytes, rows: a.rows_read, factsWritten: a.facts_written, factsUnchanged: a.facts_unchanged, error: a.error })),
    },
    understanding: {
      facts: Object.fromEntries(['FACT', 'ESTIMATE', 'INFERENCE', 'UNKNOWN'].map((e) => [e, facts.filter((f) => f.epistemic === e).reduce((t, f) => t + f.n, 0)])),
      byClass: facts.reduce<Record<string, number>>((acc, f) => ({ ...acc, [f.metric_class]: (acc[f.metric_class] ?? 0) + f.n }), {}),
      industriesTitled: industries.total,
      industriesMeasured: Number(measured?.n ?? 0),
      industriesInterpreted: industries.interpreted,
      byCustomer: industries.byCustomer,
      interpreted: interpreted.map((i) => ({
        naics: i.naics,
        label: i.label,
        customer: i.customer_category,
        mechanisms: parse(i.mechanisms, {}),
        interpretation: i.interpretation,
        principles: parse<string[]>(i.principles, []),
        requirements: parse<string[]>(i.requirements, []),
        unknowns: parse<string[]>(i.unknowns, []),
        servedBy: i.interpreted_served_by,
        at: i.interpreted_at,
      })),
    },
    mechanisms: { revenueBases: revenue, mechanisms },
    recent: {
      factsThisWeek: await factsAddedSince(weekAgo),
      derived: (await recentFacts(weekAgo, 15)).map((f) => ({ metric: METRICS[f.metric as keyof typeof METRICS]?.label ?? f.metric, naics: f.naics, industry: f.industry_label, value: Number(f.value), unit: f.unit, period: f.period, epistemic: f.epistemic, basis: f.basis })),
    },
    missing: {
      buyersUnclassified: unmatched.map((l) => ({ buyer: l.node_name, why: l.rationale })),
      withheldCells: unknownCells,
      staleFacts: await staleFactCount(nowIso),
      industriesUninterpreted: uninterpreted,
      sourcesWithoutReader: candidates.map((s) => ({ key: s.source_key, title: s.title, url: s.url, why: s.value_reason })),
      failingSources: sources.filter((s) => s.status === 'FAILING').map((s) => ({ key: s.source_key, error: s.last_error, nextDueAt: s.next_due_at })),
      contradictions: contradictions.filter((c) => c.resolution === 'UNRESOLVED').length,
    },
    plans: {
      applied: counts,
      buyersLinked: links.length - unmatched.length,
      recent: applications.slice(0, 25).map((a) => ({ kind: a.kind, at: a.created_at, projectId: a.project_id, detail: a.detail, before: a.before_text, after: a.after_text, ref: a.target_ref })),
      contradictions: { counts: await contradictionCounts(), recent: contradictions.slice(0, 10) },
    },
    capacity: {
      gpuAvailable: gpu,
      sourcesDue: due.length,
      readsLast24h: readsToday.length,
      interpretationsLast24h: Number(interpretedToday?.n ?? 0),
      // Idle beside work: a dataset waiting with no pass in the last half hour, or industries unread while the GPU is reachable and read nothing today.
      idleBesideWork:
        (due.length > 0 && (!pass || Date.parse(pass.at) < now.getTime() - 30 * 60_000)) ||
        (gpu && uninterpreted > 0 && Number(interpretedToday?.n ?? 0) === 0),
      note: 'A pass runs at most every fifteen minutes beside the Russell tick: up to three dataset reads and four GPU calls, more only when the lane has spare capacity.',
    },
  };
}
