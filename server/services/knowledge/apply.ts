/**
 * Where commercial knowledge reaches planning (§121, through §92's W-5 path).
 *
 * A plan reads a buyer population's size from a `construction_facts` row
 * segmented to that population's map node (`constructionObservations`,
 * cash/construct.ts). So each BUYER_TYPE node of a project with a live goal
 * is classified into the NAICS industries it is — deterministically by its
 * words, and by the GPU only when the words match nothing — and the census
 * count of those industries in the goal's market is filed on it as an
 * OBSERVED, PRIMARY fact. Its lineage is `knw:<node>:accounts_reachable`, one
 * per node: a newer vintage supersedes it as a new row (migration 158), so
 * the history stays and the plan reads the newest.
 *
 * What it changed is recorded, never assumed: the fact filed and what the
 * node held before; an assumption it contradicted and how that was resolved;
 * a research question it answered; and — when a plan next composes the
 * arrangement over those buyers — that the plan's buyer count is now
 * established and what the next research question became.
 */
import {
  LEXICAL_FLOOR,
  chooseIndustries,
  geoCode,
  geoLabel,
  judgeBuyerCount,
  lexicalNaicsMatches,
  sizeClassOf,
  stateNamedIn,
} from '../../domain/commercialKnowledge.ts';
import type { IndustryNode, KnowledgeFactRow } from '../../domain/types.ts';
import { getDb } from '../../db/database.ts';
import { listNodes } from '../../repos/industry.ts';
import { listCurrentClaimFacts, listProjectConstructionFacts, recordClaimFact } from '../../repos/construction.ts';
import { setUncertaintyDisposition } from '../../repos/researchIntelligence.ts';
import {
  currentFactsFor,
  getLink,
  industryTitles,
  insertLink,
  listApplications,
  listLinks,
  recordApplication,
  recordContradiction,
  upgradeUnmatchedLink,
} from '../../repos/commercialKnowledge.ts';
import { classifyWithModel, modelAvailable, type ModelDeps } from './interpret.ts';

const norm = (text: string | null | undefined) => (text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** The lineage of the one buyer-count fact Brain files on a node. */
export const buyerCountClaimId = (nodeId: string) => `knw:${nodeId}:accounts_reachable`;
export const isKnowledgeLineage = (claimId: string | null | undefined) => !!claimId && claimId.startsWith('knw:');

/** A model answer that could not be had is retried; one that said "no industry" is kept. */
const NO_MODEL = 'NO_MODEL:';

/** Projects that hold a live goal: knowledge goes first where an objective will read it. */
export async function projectsWithLiveGoals(): Promise<{ projectId: string; goalTitles: string[] }[]> {
  const rows = await getDb().all<{ target_project_id: string; title: string }>(
    `SELECT target_project_id, title FROM workstreams
      WHERE target_metric IS NOT NULL AND target_project_id IS NOT NULL AND archived_at IS NULL AND cancelled_at IS NULL AND paused_at IS NULL`,
  );
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.target_project_id, [...(out.get(r.target_project_id) ?? []), r.title]);
  return [...out].map(([projectId, goalTitles]) => ({ projectId, goalTitles }));
}

export interface LinkOutcome {
  nodeId: string;
  method: 'LEXICAL' | 'MODEL' | 'NONE';
  codes: string[];
  created: boolean;
}

function rootOf(node: IndustryNode, byId: Map<string, IndustryNode>): IndustryNode {
  let current = node;
  const seen = new Set<string>();
  while (current.parentId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = byId.get(current.parentId);
    if (!parent) break;
    current = parent;
  }
  return current;
}

/** Classify one buyer node into NAICS industries, once. */
export async function linkNode(
  node: IndustryNode,
  root: IndustryNode,
  titles: readonly { naics: string; label: string }[],
  context: string,
  modelBudget: { left: number },
  deps: ModelDeps = {},
): Promise<LinkOutcome | null> {
  const existing = await getLink(node.projectId, node.id);
  if (existing && !(existing.method === 'NONE' && existing.rationale.startsWith(NO_MODEL))) return null;
  const describe = `${node.name}${node.description ? ` — ${node.description}` : ''}`;
  const geo = geoCode(stateNamedIn(`${node.name} ${root.name} ${context}`));
  const size = sizeClassOf(describe);
  const chosen = chooseIndustries(describe, titles);
  const best = lexicalNaicsMatches(describe, titles, 1)[0];
  let row: { naics: string[]; method: 'LEXICAL' | 'MODEL' | 'NONE'; score: number; rationale: string; servedBy: string | null };
  if (chosen) {
    row = { naics: chosen.codes, method: 'LEXICAL', score: chosen.matches[0]?.score ?? 0, rationale: `words shared with the NAICS titles: ${chosen.matches.map((m) => `${m.naics} ${m.label} [${m.matched.join(', ')}]`).join('; ')}`, servedBy: null };
  } else if (modelBudget.left > 0 && modelAvailable(deps)) {
    modelBudget.left--;
    const answer = await classifyWithModel(describe, titles, deps);
    row = answer.value
      ? { naics: answer.value.codes, method: answer.value.codes.length > 0 ? 'MODEL' : 'NONE', score: answer.value.codes.length > 0 ? 0.5 : 0, rationale: answer.value.why || 'the model named no industry', servedBy: answer.servedBy }
      : { naics: [], method: 'NONE', score: 0, rationale: `${NO_MODEL} ${answer.error ?? 'no answer'}`, servedBy: answer.servedBy };
  } else {
    row = { naics: [], method: 'NONE', score: best?.score ?? 0, rationale: `${NO_MODEL} no title matched above ${LEXICAL_FLOOR}${best ? ` (best ${best.naics} at ${best.score})` : ''} and no model call was available this pass`, servedBy: null };
  }
  if (existing) {
    await upgradeUnmatchedLink(node.projectId, node.id, { naics: JSON.stringify(row.naics), method: row.method, score: row.score, rationale: row.rationale.slice(0, 1000), served_by: row.servedBy });
  } else {
    await insertLink({ project_id: node.projectId, node_id: node.id, node_name: node.name, naics: JSON.stringify(row.naics), method: row.method, score: row.score, size_class: size, geo_code: geo, rationale: row.rationale.slice(0, 1000), served_by: row.servedBy });
  }
  return { nodeId: node.id, method: row.method, codes: row.naics, created: !existing };
}

/** The newest published figure of a metric for these codes in a geography: one per code. */
function newestPer(facts: readonly KnowledgeFactRow[], metric: string, geo: string, codes: readonly string[]): KnowledgeFactRow[] | null {
  const out: KnowledgeFactRow[] = [];
  for (const code of codes) {
    const best = facts
      .filter((f) => f.naics === code && f.metric === metric && f.geo_code === geo && f.size_class === 'ALL')
      .sort((a, b) => b.period.localeCompare(a.period) || (a.subject_key.startsWith('CBP') ? -1 : 1))[0];
    if (!best || best.epistemic !== 'FACT') return null;
    out.push(best);
  }
  return out;
}

export interface BuyerCount {
  low: number;
  high: number;
  employer: KnowledgeFactRow[];
  nonemployer: KnowledgeFactRow[];
  geo: string;
  measures: string;
}

/**
 * How many buyers of these industries the market holds: employer
 * establishments (under 20 employees when the description says small) as the
 * low end, plus businesses with no employees as the high end where the
 * nonemployer count is held for that market.
 */
export function buyerCountFrom(facts: readonly KnowledgeFactRow[], codes: readonly string[], size: string, geo: string, titleOf: (code: string) => string): BuyerCount | null {
  if (codes.length === 0) return null;
  const metric = size === 'SMALL' ? 'SMALL_ESTABLISHMENTS' : 'ESTABLISHMENTS';
  const employer = newestPer(facts, metric, geo, codes) ?? (geo !== 'US' ? null : null);
  if (!employer) return null;
  const low = employer.reduce((t, f) => t + Number(f.value), 0);
  if (!(low > 0)) return null;
  const nonemployer = newestPer(facts, 'NONEMPLOYER_ESTABLISHMENTS', geo, codes) ?? [];
  const high = low + nonemployer.reduce((t, f) => t + Number(f.value), 0);
  const industries = codes.map((c) => `${c} ${titleOf(c)}`).join('; ');
  const vintage = [...new Set(employer.map((f) => f.period))].join(', ');
  const measures =
    `${size === 'SMALL' ? 'Employer establishments under 20 employees' : 'Employer establishments'} in NAICS ${industries} (${geoLabel(geo)}, ${vintage})` +
    (nonemployer.length > 0 ? `; up to ${high.toLocaleString('en-US')} counting businesses without employees (${[...new Set(nonemployer.map((f) => f.period))].join(', ')})` : '');
  return { low: Math.round(low), high: Math.round(high), employer, nonemployer, geo, measures };
}

export interface ApplyOutcome {
  projectId: string;
  nodes: number;
  linked: number;
  filed: number;
  superseded: number;
  contradictions: number;
  questionsResolved: number;
}

/**
 * Bring a project's buyer nodes up to what the acquired datasets know.
 * Bounded by `maxLinks` new classifications and `modelBudget` GPU calls.
 */
export async function applyKnowledgeToProject(projectId: string, context: string, options: { maxLinks?: number; modelBudget?: { left: number }; deps?: ModelDeps } = {}): Promise<ApplyOutcome> {
  const out: ApplyOutcome = { projectId, nodes: 0, linked: 0, filed: 0, superseded: 0, contradictions: 0, questionsResolved: 0 };
  const titles = (await industryTitles()).filter((t) => t.naics.length >= 4);
  if (titles.length === 0) return out;
  const titleOf = new Map(titles.map((t) => [t.naics, t.label]));
  const all = await listNodes(projectId);
  const byId = new Map(all.map((n) => [n.id, n]));
  const buyers = all.filter((n) => n.kind === 'BUYER_TYPE' && !n.retiredAt);
  out.nodes = buyers.length;
  const budget = options.modelBudget ?? { left: 2 };
  let linksLeft = options.maxLinks ?? 40;
  for (const node of buyers) {
    if (linksLeft <= 0) break;
    const linked = await linkNode(node, rootOf(node, byId), titles, context, budget, options.deps);
    if (linked) {
      linksLeft--;
      if (linked.codes.length > 0) out.linked++;
    }
  }

  const links = (await listLinks(projectId)).filter((l) => l.method !== 'NONE');
  const facts = await listProjectConstructionFacts(projectId);
  for (const link of links) {
    const node = byId.get(link.node_id);
    if (!node || node.retiredAt) continue;
    const codes = JSON.parse(link.naics) as string[];
    const held = await currentFactsFor(codes, [...new Set([link.geo_code, 'US'])]);
    const count = buyerCountFrom(held, codes, link.size_class, link.geo_code, (c) => titleOf.get(c) ?? '') ??
      (link.geo_code !== 'US' ? buyerCountFrom(held, codes, link.size_class, 'US', (c) => titleOf.get(c) ?? '') : null);
    if (!count) continue;
    const claimId = buyerCountClaimId(node.id);
    const current = (await listCurrentClaimFacts(claimId))[0] ?? null;
    if (current && current.low === count.low && current.high === count.high) continue;
    const source = count.employer[0]!;
    const filed = await recordClaimFact({
      projectId,
      nodeId: node.id,
      claimId,
      key: 'accounts_reachable',
      segment: `map_${node.id}`,
      low: count.low,
      high: count.high,
      status: 'OBSERVED',
      measures: count.measures.slice(0, 500),
      sourceTitle: source.source_title,
      sourceUrl: source.source_url,
      sourceKind: 'PRIMARY',
      observedAt: source.observed_at,
      validUntil: source.valid_until,
      supersedesFactId: current?.id ?? null,
    });
    if (!filed) continue;
    if (current) out.superseded++;
    else out.filed++;

    // What the node held before, from anyone else: the plan's input before this fact.
    const prior = facts.filter((f) => f.key === 'accounts_reachable' && f.segment === `map_${node.id}` && !isKnowledgeLineage(f.sourceClaimId));
    const evidenced = prior.filter((f) => f.status === 'OBSERVED' || f.status === 'VERIFIED');
    const before = current
      ? `the previous census reading: ${current.low.toLocaleString('en-US')}–${current.high.toLocaleString('en-US')} (${current.measures.slice(0, 160)})`
      : evidenced.length > 0
        ? `EVIDENCED: ${evidenced.map((f) => `${f.low}–${f.high} ${f.status} (${f.source.title.slice(0, 80)})`).join('; ')}`
        : prior.length > 0
          ? `NO_EVIDENCE: only ${prior.map((f) => `${f.low}–${f.high} ${f.status}`).join('; ')}, which the plan does not read; it swept the buyer count 0–10,000,000`
          : 'NO_EVIDENCE: no buyer count was filed; the plan swept it 0–10,000,000 and research would ask for it';
    await recordApplication({
      kind: 'CONSTRUCTION_FACT',
      project_id: projectId,
      node_id: node.id,
      knowledge_fact_id: source.id,
      target_ref: `construction_fact:${filed.id}`,
      detail: `accounts_reachable on "${node.name}": ${count.low.toLocaleString('en-US')}–${count.high.toLocaleString('en-US')}`,
      before_text: before.slice(0, 1000),
      after_text: count.measures.slice(0, 1000),
    });

    for (const one of prior) {
      const judged = judgeBuyerCount({ low: one.low, high: one.high, status: one.status }, count.low);
      if (!judged.contradicts) continue;
      if (
        await recordContradiction({
          subject: `How many "${node.name}" exist (${geoLabel(count.geo)})`,
          fact_a_ref: `construction_fact:${one.id}`,
          fact_b_ref: `construction_fact:${filed.id}`,
          a_value: one.low,
          b_value: count.low,
          relative_gap: Math.round((Math.abs(count.low - one.high) / Math.max(count.low, one.high, 1)) * 10_000) / 10_000,
          resolution: judged.resolution,
          reason: judged.reason,
          project_id: projectId,
        })
      ) out.contradictions++;
      if (judged.resolution === 'PREFER_B') {
        await recordApplication({
          kind: 'ASSUMPTION_REPLACED',
          project_id: projectId,
          node_id: node.id,
          knowledge_fact_id: source.id,
          target_ref: `construction_fact:${one.id}`,
          detail: `"${node.name}": the ${one.status.toLowerCase()} ${one.low}–${one.high} is outranked by the census count`,
          before_text: `${one.low}–${one.high} ${one.status} (${one.source.title.slice(0, 120)})`,
          after_text: `${count.low}–${count.high} OBSERVED (${count.measures.slice(0, 200)})`,
        });
      }
    }
    out.questionsResolved += await resolveCountQuestions(projectId, node, count, source.id);
  }
  return out;
}

/**
 * Open research questions in the project that ask how many of these buyers
 * exist: the dataset already answers them, so they are resolved with the
 * answer and its basis rather than researched (invariant 13).
 */
export async function resolveCountQuestions(projectId: string, node: Pick<IndustryNode, 'id' | 'name'>, count: BuyerCount, factId: string): Promise<number> {
  const name = norm(node.name);
  if (name.length < 4) return 0;
  const open = await getDb().all<{ orchestration_id: string; uncertainty_key: string; question: string }>(
    `SELECT orchestration_id, uncertainty_key, question FROM research_uncertainties
      WHERE project_id = ? AND disposition IN ('OPEN', 'INVESTIGATING') AND LOWER(question) LIKE '%how many%'`,
    [projectId],
  );
  let n = 0;
  for (const q of open) {
    if (!norm(q.question).includes(name)) continue;
    const belief = `${count.low.toLocaleString('en-US')}–${count.high.toLocaleString('en-US')}: ${count.measures}`.slice(0, 500);
    const done = await setUncertaintyDisposition({
      orchestrationId: q.orchestration_id,
      uncertaintyKey: q.uncertainty_key,
      from: ['OPEN', 'INVESTIGATING'],
      to: 'RESOLVED',
      reason: `Answered by an acquired public dataset (§121), not by research: ${belief}`.slice(0, 500),
      belief,
      beliefBasis: 'EVIDENCE',
      uncertaintyLevel: 10,
    });
    if (!done) continue;
    n++;
    await recordApplication({
      kind: 'UNCERTAINTY_RESOLVED',
      project_id: projectId,
      node_id: node.id,
      knowledge_fact_id: factId,
      target_ref: `uncertainty:${q.orchestration_id}:${q.uncertainty_key}`,
      detail: q.question.slice(0, 300),
      before_text: 'OPEN: waiting for research',
      after_text: belief,
    });
  }
  return n;
}

/**
 * Called by the goal plan after it composes its arrangements: for each one
 * over buyers whose count this pipeline filed where nothing evidenced one
 * before, the plan's buyer count is now established. Records, once per goal
 * and arrangement, what the plan read before and after, and what it would ask
 * research next. Never throws into the plan.
 */
export async function notePlanEffects(
  goalId: string,
  projectId: string,
  arrangements: readonly { key: string; label: string; demand: { name: string }; unknownParts: readonly string[] }[],
  nextQuestion: (one: never) => { part: string } | null,
): Promise<number> {
  const applied = (await listApplications(500, projectId)).filter((a) => a.kind === 'CONSTRUCTION_FACT' && (a.before_text ?? '').startsWith('NO_EVIDENCE'));
  if (applied.length === 0) return 0;
  const links = await listLinks(projectId);
  const nodeOfName = new Map(links.map((l) => [norm(l.node_name), l.node_id]));
  const appOfNode = new Map(applied.map((a) => [a.node_id, a]));
  // One record per goal and buyer population: how many of the goal's arrangements now read the count, and what they ask next.
  const byNode = new Map<string, { app: (typeof applied)[number]; arrangements: typeof arrangements[number][]; next: Set<string> }>();
  for (const one of arrangements) {
    const nodeId = nodeOfName.get(norm(one.demand.name));
    const app = nodeId ? appOfNode.get(nodeId) : undefined;
    if (!nodeId || !app || one.unknownParts.includes('buyers')) continue;
    const group = byNode.get(nodeId) ?? { app, arrangements: [], next: new Set<string>() };
    group.arrangements.push(one);
    const next = nextQuestion(one as never);
    group.next.add(next ? next.part.replace(/_/g, ' ') : 'the full question');
    byNode.set(nodeId, group);
  }
  let n = 0;
  for (const [nodeId, group] of byNode) {
    const buyer = group.arrangements[0]!.demand.name;
    const recorded = await recordApplication({
      kind: 'PLAN_INPUT_CHANGED',
      project_id: projectId,
      node_id: nodeId,
      knowledge_fact_id: group.app.knowledge_fact_id,
      target_ref: `goal:${goalId}:node:${nodeId}`,
      detail: `Goal ${goalId}: ${group.arrangements.length} arrangement(s) selling to "${buyer}" now read the buyer count from the census`,
      before_text: `buyers unknown, swept 0–10,000,000 in every one; the research question for "${buyer}" began with how many of them exist`,
      after_text: `buyers established (${group.app.detail.replace(/^accounts_reachable on "[^"]*": /, '')}); the next research round asks for ${[...group.next].join(', ')}`,
    });
    if (recorded) n++;
  }
  return n;
}
