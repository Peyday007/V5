/**
 * The GPU's part in commercial knowledge (§121): reading, never counting.
 *
 * Two questions go to the free lane's GPU slot (`cheap/lane.ts`, RunPod in
 * primary mode; its fallback answers when the GPU does not, and the row says
 * which did):
 *
 *   - which industries a buyer description is, when the deterministic match
 *     finds none — the unfamiliar relationship;
 *   - what an industry's measured economics mean commercially: how its
 *     businesses are paid, who pays them, what operating one requires, the
 *     principles that transfer, and what the numbers leave unknown.
 *
 * Every answer is checked against closed vocabularies and the codes the
 * datasets hold before it is kept, and is stored as INFERENCE — it never
 * becomes a fact, and no figure the planner prices comes from it.
 */
import { httpCompleter, laneConfig, type Completer, type LaneConfig } from '../cheap/lane.ts';
import { MECHANISMS, REVENUE_BASES } from '../../domain/construction.ts';
import { CUSTOMER_CATEGORIES, METRICS, type CustomerCategory } from '../../domain/commercialKnowledge.ts';
import type { KnowledgeFactRow } from '../../domain/types.ts';

export interface ModelDeps {
  config?: LaneConfig | null;
  completer?: Completer;
  env?: NodeJS.ProcessEnv;
}

export interface ModelAnswer<T> {
  value: T | null;
  model: string;
  servedBy: string;
  error: string | null;
}

/** Whether the GPU (or its lane) may be asked at all. */
export function modelAvailable(deps: ModelDeps = {}): boolean {
  const env = deps.env ?? process.env;
  if ((env['BRAIN_KNOWLEDGE_MODEL'] ?? '').trim().toLowerCase() === 'off') return false;
  return !!(deps.config === undefined ? laneConfig(env) : deps.config);
}

function jsonOf(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function ask(system: string, prompt: string, deps: ModelDeps, maxTokens: number): Promise<{ text: string | null; model: string; servedBy: string; error: string | null }> {
  const config = deps.config === undefined ? laneConfig(deps.env ?? process.env) : deps.config;
  if (!config) return { text: null, model: 'none', servedBy: 'none', error: 'no model lane configured' };
  const model = config.models[0]!;
  let servedBy = model;
  try {
    const text = await (deps.completer ?? httpCompleter)({ ...config, timeoutMs: 90_000 }, model, system, prompt, {
      maxTokens,
      json: true,
      onServed: (served) => {
        servedBy = served;
      },
    });
    return { text, model, servedBy, error: null };
  } catch (error) {
    return { text: null, model, servedBy, error: String((error as Error)?.message ?? error).slice(0, 300) };
  }
}

const CLASSIFY_SYSTEM =
  'You classify a description of a group of buyers into NAICS 2022 industries. Answer only with JSON: ' +
  '{"codes": ["4-to-6 digit codes from the list given"], "why": "one sentence"}. Choose at most three codes, only codes from the list, ' +
  'and an empty list when the description is not a kind of business or organisation (for example households, individuals or a single named company).';

/** The industries a buyer description is, chosen by the model from the codes the datasets hold. */
export async function classifyWithModel(description: string, titles: readonly { naics: string; label: string }[], deps: ModelDeps = {}): Promise<ModelAnswer<{ codes: string[]; why: string }>> {
  const list = titles.filter((t) => t.naics.length === 4).map((t) => `${t.naics} ${t.label}`).join('\n');
  const answer = await ask(CLASSIFY_SYSTEM, `Buyers: "${description}"\n\nNAICS industries:\n${list}`, deps, 400);
  if (!answer.text) return { value: null, model: answer.model, servedBy: answer.servedBy, error: answer.error };
  const parsed = jsonOf(answer.text) as { codes?: unknown; why?: unknown } | null;
  const known = new Set(titles.map((t) => t.naics));
  const codes = Array.isArray(parsed?.codes) ? parsed!.codes.map(String).filter((c) => known.has(c)).slice(0, 3) : null;
  if (!codes) return { value: null, model: answer.model, servedBy: answer.servedBy, error: 'the answer held no list of codes' };
  return { value: { codes, why: typeof parsed?.why === 'string' ? parsed.why.slice(0, 300) : '' }, model: answer.model, servedBy: answer.servedBy, error: null };
}

export interface Interpretation {
  customer: CustomerCategory;
  revenue: string[];
  mechanisms: string[];
  interpretation: string;
  principles: string[];
  requirements: string[];
  unknowns: string[];
}

const INTERPRET_SYSTEM =
  'You are a commercial analyst. From an industry\'s measured economics, state what they mean for someone deciding whether and how to make money in it. ' +
  'Answer only with JSON: {"customer": one of ' + JSON.stringify(CUSTOMER_CATEGORIES) + ', "revenue": a subset of ' + JSON.stringify(REVENUE_BASES) +
  ', "mechanisms": a subset of ' + JSON.stringify(MECHANISMS) +
  ', "interpretation": "three sentences at most, citing the figures", "principles": ["transferable principles, each one sentence"], ' +
  '"requirements": ["what operating in it requires: capital, licences, labour, equipment, cash cycle"], "unknowns": ["what these figures cannot tell, each a question"]}. ' +
  'Never invent a figure that is not given; say it is unknown instead.';

/** The measured profile, as the model reads it: every figure with its metric, kind and basis. */
export function profileText(label: string, naics: string, facts: readonly Pick<KnowledgeFactRow, 'metric' | 'value' | 'unit' | 'epistemic' | 'period' | 'size_class' | 'basis'>[]): string {
  const lines = facts
    .filter((f) => f.epistemic !== 'UNKNOWN')
    .slice(0, 40)
    .map((f) => `- ${METRICS[f.metric as keyof typeof METRICS]?.label ?? f.metric}${f.size_class === 'SMALL' ? ' (firms under 20 employees)' : f.size_class === 'PUBLIC' ? ' (public companies in the whole sector)' : ''}, ${f.period}: ${Number(f.value).toLocaleString('en-US', { maximumFractionDigits: 3 })} ${f.unit} [${f.epistemic}${f.epistemic === 'ESTIMATE' ? `: ${f.basis}` : ''}]`);
  return `Industry: NAICS ${naics} ${label} (United States)\n${lines.join('\n')}`;
}

export async function interpretIndustry(label: string, naics: string, facts: readonly KnowledgeFactRow[], deps: ModelDeps = {}): Promise<ModelAnswer<Interpretation>> {
  const answer = await ask(INTERPRET_SYSTEM, profileText(label, naics, facts), deps, 1200);
  if (!answer.text) return { value: null, model: answer.model, servedBy: answer.servedBy, error: answer.error };
  const p = jsonOf(answer.text) as Record<string, unknown> | null;
  if (!p || typeof p['interpretation'] !== 'string' || !(p['interpretation'] as string).trim()) {
    return { value: null, model: answer.model, servedBy: answer.servedBy, error: 'the answer held no interpretation' };
  }
  const strings = (v: unknown, max: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.slice(0, 300)).slice(0, max) : []);
  const customer = (CUSTOMER_CATEGORIES as readonly string[]).includes(String(p['customer'])) ? (p['customer'] as CustomerCategory) : 'MIXED';
  return {
    value: {
      customer,
      revenue: strings(p['revenue'], 7).filter((x) => (REVENUE_BASES as readonly string[]).includes(x)),
      mechanisms: strings(p['mechanisms'], 17).filter((x) => (MECHANISMS as readonly string[]).includes(x)),
      interpretation: (p['interpretation'] as string).slice(0, 1200),
      principles: strings(p['principles'], 6),
      requirements: strings(p['requirements'], 6),
      unknowns: strings(p['unknowns'], 6),
    },
    model: answer.model,
    servedBy: answer.servedBy,
    error: null,
  };
}
