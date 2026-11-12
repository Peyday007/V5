/**
 * Sellbird's sales mind, as Brain calls it (§107): research, fit, writing,
 * sequences, reply analysis, the analyst, the trainer, offer design and
 * deliverability — each a narrow call to the agents service
 * (`agents/brain_agents/sales.py`), each one USAGE row under
 * `open-source-agents` with any address reduced to its domain.
 *
 * The model is Brain's own: the RunPod GPU it already runs, else the cheap
 * lane's named free model (`browserModel`). No paid model API is ever named
 * here, and with neither configured the model calls are not made at all.
 * Nothing here sends: Sellbird's drafted answers come back to the sales desk,
 * which decides under Brain's rules and sends through Instantly.
 */
import { recordIntegrationEvent } from '../../repos/integrationEvents.ts';
import { AGENTS_INTEGRATION, agentsConfig, browserModel, call, maskEmail, type Fetch } from './client.ts';

/** A business as Sellbird's config reads it (`sales.build_config`). */
export interface SalesOffer {
  brand: string;
  sender: { name: string; role?: string; tone?: string };
  product: {
    name: string;
    description: string;
    pricing?: string;
    benefits?: string[];
    objections?: Record<string, string>;
    /** The free, real thing a first email offers (Sellbird's product.offer.entry). */
    entry?: string;
  };
  industries?: string[];
  titles?: string[];
  geography?: string[];
  postalAddress: string;
  optOutLine?: string;
  phoneNumbers?: string[];
  linkDomains?: string[];
  doNotContact?: string[];
  /** Product knowledge and competition: the trainer's skills, from the business's own documents. */
  knowledge?: string;
  competition?: string;
  /** What the business sent, so a quoted footer is never read as the prospect's words. */
  sentTexts?: string[];
  /** What Brain measured on this campaign's replies, for the writer. */
  feedback?: string[];
}

export interface SalesObservation {
  signal_code: string;
  value_num: number | null;
  value_text: string | null;
  confidence: number | null;
  evidence_url: string | null;
}

export interface SalesResearch {
  domain: string;
  reachable: boolean;
  challenged: boolean;
  siteName: string;
  pagesRead: number;
  people: { firstName: string; lastName: string; title: string; owner: boolean; email: string | null; status: string; published: boolean; evidenceUrl: string }[];
  inbox: { email: string; published: boolean } | null;
  publishedAddresses: string[];
  description: string;
  techStack: string[];
  facts: string[];
  observations: SalesObservation[];
  fit: { score: number; reasons: string[] } | null;
  error?: string;
}

export interface SalesLeadInput {
  email: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  company: string;
  website?: string;
  industry?: string;
  location?: string;
  description?: string;
  techStack?: string[];
  observations?: SalesObservation[];
  notes?: string;
  published?: boolean;
  optedOut?: boolean;
  stage?: string;
  withPerson?: boolean;
}

export interface SalesDraft {
  ok: boolean;
  reason?: string;
  subject?: string;
  body?: string;
  problems?: string[];
  tipBasis?: boolean;
  calls?: { agent: string; task: string; ok: boolean }[];
}

export interface SalesReplyDecision {
  intent: string;
  stage: string;
  status: string;
  prospectStatus: string;
  optOut: { rule?: string; matched?: string; why?: string } | null;
  escalations: { reason?: string; reply_preview?: string }[];
  answer: string;
  calls?: { agent: string; task: string; ok: boolean }[];
  error?: string;
}

export interface SalesCheck { name: string; status: string; detail: string; unknown: boolean }

interface CallOptions { env?: NodeJS.ProcessEnv; fetch?: Fetch; source?: string }

async function record(state: string, detail: string, source: string): Promise<void> {
  await recordIntegrationEvent({ integrationId: AGENTS_INTEGRATION, kind: 'USAGE', state, detail, source });
}

/** One call: null when the service or (for model work) the model is not configured, or the call failed. */
async function sales<T>(
  path: string,
  body: Record<string, unknown>,
  options: CallOptions & { model: boolean; timeoutMs: number; label: string; describe: (out: T) => { state: string; detail: string } },
): Promise<T | null> {
  const env = options.env ?? process.env;
  const cfg = agentsConfig(env);
  if (!cfg) return null;
  const llm = options.model ? browserModel(env) : null;
  if (options.model && !llm) return null;
  const source = options.source ?? 'sales desk';
  try {
    const out = await call<T>(cfg, path, options.model ? { ...body, llm } : body, options.timeoutMs, options.fetch ?? fetch);
    const said = options.describe(out);
    await record(said.state, `${options.label}${llm ? ` on ${llm.model}` : ''}: ${said.detail}`, source);
    return out;
  } catch (error) {
    await record(`SELLBIRD_${options.label.toUpperCase().replace(/[^A-Z]+/g, '_')}_FAILED`,
      `${options.label}: ${error instanceof Error ? error.message : String(error)}`, source);
    return null;
  }
}

export function sellbirdResearch(website: string, offer: SalesOffer | null, options: CallOptions & { industry?: string; titles?: string[] } = {}): Promise<SalesResearch | null> {
  return sales<SalesResearch>('/v1/sellbird/research', { website, offer, industry: options.industry ?? '', titles: options.titles }, {
    ...options, model: false, timeoutMs: 170_000, label: 'research',
    describe: (o) => ({
      state: o.error ? 'SELLBIRD_RESEARCH_FAILED' : 'SELLBIRD_RESEARCH',
      detail: `${o.domain}: ${o.pagesRead} page(s), ${o.observations?.length ?? 0} signal(s), ${o.facts?.length ?? 0} fact line(s), fit ${o.fit?.score ?? '-'}${o.fit ? ` (${o.fit.reasons.join('; ')})` : ''}${o.error ? `; ${o.error}` : ''}`,
    }),
  });
}

export function sellbirdWrite(offer: SalesOffer, lead: SalesLeadInput, options: CallOptions = {}): Promise<SalesDraft | null> {
  return sales<SalesDraft>('/v1/sellbird/write', { offer, lead }, {
    ...options, model: true, timeoutMs: 320_000, label: 'write',
    describe: (o) => ({
      state: o.ok ? 'SELLBIRD_WROTE' : 'SELLBIRD_NOT_WRITTEN',
      detail: `${maskEmail(lead.email)}: ${o.ok ? `"${o.subject ?? ''}"` : o.reason ?? 'no draft'} (${o.calls?.length ?? 0} model call(s))`,
    }),
  });
}

export interface SalesSequence { ok: boolean; steps: { step: number; subject: string; body: string; delayDays: number }[]; reason?: string }

export function sellbirdSequence(offer: SalesOffer, sample: SalesLeadInput[], options: CallOptions = {}): Promise<SalesSequence | null> {
  return sales<SalesSequence>('/v1/sellbird/sequence', { offer, sample: sample.slice(0, 5) }, {
    ...options, model: true, timeoutMs: 440_000, label: 'sequence',
    describe: (o) => ({
      state: o.ok ? 'SELLBIRD_SEQUENCE' : 'SELLBIRD_SEQUENCE_NONE',
      detail: `${offer.brand}: ${o.steps.length} step(s)${o.reason ? `; ${o.reason}` : ''}`,
    }),
  });
}

export function sellbirdReply(
  offer: SalesOffer,
  lead: SalesLeadInput,
  reply: { id: string; text: string },
  history: { from: 'us' | 'them'; text: string }[],
  options: CallOptions = {},
): Promise<SalesReplyDecision | null> {
  return sales<SalesReplyDecision>('/v1/sellbird/reply', { offer, lead, reply, history: history.slice(-20) }, {
    ...options, model: true, timeoutMs: 320_000, label: 'reply',
    describe: (o) => ({
      state: o.error ? 'SELLBIRD_REPLY_FAILED' : `SELLBIRD_REPLY_${(o.intent || 'unknown').toUpperCase()}`,
      detail: `${maskEmail(lead.email)}: intent ${o.intent || '-'}, stage ${o.stage || '-'}, ${o.answer ? 'answer drafted' : 'no answer'}${o.optOut ? `, opt-out (${o.optOut.rule})` : ''}${o.escalations?.length ? ', escalated' : ''}${o.error ? `; ${o.error}` : ''}`,
    }),
  });
}

export function sellbirdInsights(report: Record<string, unknown>, options: CallOptions = {}): Promise<{ insights: string[] } | null> {
  return sales('/v1/sellbird/insights', { report }, {
    ...options, model: false, timeoutMs: 20_000, label: 'insights',
    describe: (o: { insights: string[] }) => ({ state: 'SELLBIRD_INSIGHTS', detail: `${o.insights.length} finding(s)` }),
  });
}

export function sellbirdKnowledge(source: { url?: string; pages?: Record<string, string> }, options: CallOptions = {}): Promise<Record<string, unknown> | null> {
  return sales('/v1/sellbird/knowledge', { url: source.url ?? '', pages: source.pages ?? null }, {
    ...options, model: true, timeoutMs: 920_000, label: 'knowledge',
    describe: (o: Record<string, unknown>) => ({
      state: o.error ? 'SELLBIRD_KNOWLEDGE_FAILED' : 'SELLBIRD_KNOWLEDGE',
      detail: `${String(o.pages ?? 0)} page(s); objections ${Object.keys((o.objections as Record<string, unknown>) ?? {}).length}${o.error ? `; ${String(o.error)}` : ''}`,
    }),
  });
}

export interface SalesOfferIdeas { ideas: { offer?: string; finding?: string; why?: string }[] }

export function sellbirdOffers(offer: SalesOffer, options: CallOptions = {}): Promise<SalesOfferIdeas | null> {
  return sales<SalesOfferIdeas>('/v1/sellbird/offers', { offer }, {
    ...options, model: true, timeoutMs: 320_000, label: 'offers',
    describe: (o) => ({ state: 'SELLBIRD_OFFERS', detail: `${offer.brand}: ${o.ideas.length} idea(s)` }),
  });
}

export function sellbirdDeliverability(domain: string, options: CallOptions = {}): Promise<{ domain: string; checks: SalesCheck[] } | null> {
  return sales('/v1/sellbird/deliverability', { domain }, {
    ...options, model: false, timeoutMs: 60_000, label: 'deliverability',
    describe: (o: { domain: string; checks: SalesCheck[] }) => ({
      state: o.checks.some((c) => c.status === 'fail' && !c.unknown) ? 'SELLBIRD_DELIVERABILITY_FAIL' : 'SELLBIRD_DELIVERABILITY_OK',
      detail: `${o.domain}: ${o.checks.map((c) => `${c.name} ${c.unknown ? 'unknown' : c.status}`).join(', ')}`,
    }),
  });
}
