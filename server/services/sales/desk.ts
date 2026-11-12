/**
 * The sales desk (§107): Sellbird's sales mind working every Brain business
 * that sells through the owner's Instantly workspace. Instantly sends; Brain
 * decides and keeps the record; Sellbird's own code answers each question on
 * Brain's own model.
 *
 * A pass does four independent things and reports each:
 *
 *  1. REPLIES  — every reply received on every business's campaigns, once
 *     (`sales_replies`, keyed by Instantly's email id). Sellbird reads it:
 *     opt-out and legal wording by rule before any model call, then its
 *     intent classifier, its stage machine and its drafted answer under its
 *     own send gate. Brain then acts:
 *       unsubscribe  -> the workspace block list (suppressed everywhere) and
 *                       the lead marked not interested;
 *       not_interested / wrong_person / ooo -> the lead's interest status;
 *       escalate or needs_human -> left for the owner, nothing sent;
 *       accepted_offer, or an answer that promises something a text reply
 *                       cannot carry -> held for fulfilment;
 *       interested / question / objection / wrong_person with an answer ->
 *                       sent in the thread, from the mailbox that received the
 *                       reply, only when the business allows Brain to answer,
 *                       nobody answered the thread already, every figure in it
 *                       is in the business's own facts, and it promises no
 *                       deliverable.
 *  2. LEARN    — per business, every six hours: Instantly's own counts and
 *     Brain's reply intents through Sellbird's analyst; the personal variant
 *     against the template on positive replies per send, which sets the next
 *     allocation; and what prospects asked, which the writer reads.
 *  3. DELIVERABILITY — daily: Sellbird's DNS checks of every sending domain.
 *  4. KNOWLEDGE — weekly: Sellbird's trainer over each business's own facts
 *     (objections and answers the reply handler uses).
 *
 * Nothing here sends a first email: Instantly does, on campaigns the owner
 * authorized. Nothing here spends money. Every model call is Brain's own model.
 */
import { recordIntegrationEvent } from '../../repos/integrationEvents.ts';
import {
  latestSalesLearning, recordSalesLearning, recordSalesReply, salesLead, salesLeadCounts, salesReplies,
  salesRepliesFrom, salesReplySeen, saveSalesLead,
} from '../../repos/salesDesk.ts';
import {
  sellbirdDeliverability, sellbirdInsights, sellbirdKnowledge, sellbirdReply, sellbirdResearch, sellbirdWrite,
  type SalesOffer,
} from '../agents/sellbird.ts';
import { AGENTS_INTEGRATION, agentsConfig, browserModel } from '../agents/client.ts';
import { instantly, itemsOf, rootDomain, type Deps, type PersonalDesk, type PersonalLead } from '../cash/neighborCard.ts';
import { SALES_BUSINESSES, salesBusiness, type SalesBusiness } from './businesses.ts';

export const LEARN_PERIOD_MS = 6 * 60 * 60_000;
export const DELIVERABILITY_PERIOD_MS = 24 * 60 * 60_000;
export const KNOWLEDGE_PERIOD_MS = 7 * 24 * 60 * 60_000;
/** Replies analysed per pass (each is a few model calls). */
export const REPLIES_PER_PASS = 25;
/** Personal first emails per Neighbor Card pass at a share of 1.0. */
export const MAX_PERSONAL_PER_PASS = 12;
export const DEFAULT_PERSONAL_SHARE = 0.5;
/** Sends each variant needs before its reply rate moves the allocation. */
export const MIN_SENDS_TO_LEARN = 150;

/** Instantly's lead interest values (API v2 `update-interest-status`). */
const INTEREST: Record<string, number> = {
  interested: 1, accepted_offer: 1, question: 1, objection: 1,
  ooo: 0, not_interested: -1, unsubscribe: -1, wrong_person: -2,
};

/* ------------------------------------------------------------------------- */
/* Checks Brain applies to every answer on top of Sellbird's own gate        */
/* ------------------------------------------------------------------------- */

const FIGURE = /\$\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?%|\b\d{1,3}(?:,\d{3})+\b|\b\d{2,}\b/g;

function digits(text: string): string {
  return text.replace(/[^\d.]/g, '').replace(/\.$/, '');
}

/** Figures in an answer that appear in none of the business's facts or the conversation. */
export function ungroundedFigures(answer: string, sources: string[]): string[] {
  const known = new Set<string>();
  for (const source of sources) for (const m of source.match(FIGURE) ?? []) known.add(digits(m));
  return [...new Set((answer.match(FIGURE) ?? []).filter((m) => !known.has(digits(m))))];
}

const PROMISE = /\b(attach(?:ed|ment)?|enclos(?:ed|ing)|i(?:'| wi)ll send|we(?:'| wi)ll send|i will be sending|sending (?:you|over|it)|send (?:you|it|them|those|that|over|the)|pdf|sample|mock-?up|route map|rate card|order form|payment link|invoice)\b/i;

/** Whether an answer promises something a text reply cannot carry. */
export function promisesDeliverable(answer: string): boolean {
  return PROMISE.test(answer);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Plain text as the paragraphs Instantly sends. */
export function textToHtml(text: string): string {
  return text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
}

function htmlToText(html: string): string {
  return html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&rsquo;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/* ------------------------------------------------------------------------- */
/* Replies                                                                   */
/* ------------------------------------------------------------------------- */

interface Mail { id: string; threadId: string; at: string; from: string; eaccount: string; subject: string; text: string; ours: boolean; campaignId: string; lead: string }

function mailOf(m: Record<string, unknown>): Mail {
  const body = (m.body ?? {}) as { text?: string; html?: string };
  const text = (body.text && body.text.trim()) || (body.html ? htmlToText(body.html) : '') || String(m.content_preview ?? '');
  const ueType = Number(m.ue_type);
  return {
    id: String(m.id ?? ''),
    threadId: String(m.thread_id ?? ''),
    at: String(m.timestamp_email ?? m.timestamp_created ?? ''),
    from: String(m.from_address_email ?? '').toLowerCase(),
    eaccount: String(m.eaccount ?? ''),
    subject: String(m.subject ?? ''),
    text,
    // 2 is received; 1 sent by the campaign, 3 a manual send, 4 a scheduled reply.
    ours: ueType === 1 || ueType === 3 || ueType === 4,
    campaignId: String(m.campaign_id ?? ''),
    lead: String(m.lead ?? m.from_address_email ?? '').toLowerCase(),
  };
}

async function campaignIds(deps: Deps): Promise<Map<string, { id: string; status: number }>> {
  const out = new Map<string, { id: string; status: number }>();
  for (const c of itemsOf(await instantly(deps, 'GET', '/campaigns?limit=100'))) {
    out.set(String(c.name), { id: String(c.id), status: Number(c.status) });
  }
  return out;
}

const accountNames = new Map<string, string>();
/** The name the receiving mailbox signs with: the sender identity stays the account's own. */
async function accountName(deps: Deps, email: string, fallback: string): Promise<string> {
  if (accountNames.has(email)) return accountNames.get(email)!;
  try {
    const a = await instantly(deps, 'GET', `/accounts/${encodeURIComponent(email)}`);
    const name = [a.first_name, a.last_name].filter((x) => typeof x === 'string' && x.trim()).join(' ').trim();
    accountNames.set(email, name || fallback);
  } catch {
    accountNames.set(email, fallback);
  }
  return accountNames.get(email)!;
}

/** The business's offer as Sellbird reads it, with what Brain has learned added. */
async function offerFor(business: SalesBusiness, signer?: string): Promise<SalesOffer> {
  const knowledge = await latestSalesLearning(business.id, 'KNOWLEDGE');
  const feedback = await latestSalesLearning(business.id, 'WRITER_FEEDBACK');
  const objections = (knowledge?.detail['objections'] ?? null) as Record<string, string> | null;
  return {
    ...business.offer,
    sender: { ...business.offer.sender, ...(signer ? { name: signer } : {}) },
    product: {
      ...business.offer.product,
      objections: { ...(objections && typeof objections === 'object' ? flattenObjections(objections) : {}), ...(business.offer.product.objections ?? {}) },
    },
    feedback: Array.isArray(feedback?.detail['notes']) ? (feedback!.detail['notes'] as string[]).slice(0, 8) : [],
  };
}

/** The trainer's objections as Sellbird's `trigger -> approach` map. */
function flattenObjections(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const list = Array.isArray(raw['objections']) ? (raw['objections'] as Record<string, unknown>[]) : [];
  for (const o of list.slice(0, 8)) {
    const trigger = String(o['objection'] ?? o['trigger'] ?? '').slice(0, 60);
    const answer = String(o['response'] ?? o['answer'] ?? '').slice(0, 300);
    if (trigger && answer) out[trigger] = answer;
  }
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && k.length <= 60) out[k] = v.slice(0, 300);
  return out;
}

function factsOf(business: SalesBusiness): string[] {
  const p = business.offer.product;
  return [business.offer.knowledge ?? '', p.description, p.pricing ?? '', ...(p.benefits ?? []), p.entry ?? '', business.offer.postalAddress, ...(business.offer.phoneNumbers ?? [])];
}

export interface ReplyOutcome { business: string; emailId: string; intent: string; action: string; detail: string }

/** Analyse and act on one reply. Returns null when it should be retried next pass (the model did not answer). */
export async function handleOneReply(deps: Deps, business: SalesBusiness, reply: Mail, thread: Mail[]): Promise<ReplyOutcome | null> {
  const signer = await accountName(deps, reply.eaccount, business.offer.sender.name);
  const offer = await offerFor(business, signer);
  const earlier = thread.filter((m) => m.at < reply.at && m.id !== reply.id);
  const history = earlier.map((m) => ({ from: (m.ours ? 'us' : 'them') as 'us' | 'them', text: m.text.slice(0, 3000) }));
  offer.sentTexts = earlier.filter((m) => m.ours).map((m) => m.text).slice(-6);
  const known = await salesLead(business.id, reply.lead);
  const past = await salesRepliesFrom(reply.lead);
  const lead = {
    email: reply.lead,
    company: String(known?.research['siteName'] ?? '') || rootDomain(reply.lead.split('@')[1] ?? ''),
    website: known ? `https://${known.domain}` : `https://${reply.lead.split('@')[1] ?? ''}`,
    optedOut: past.some((r) => r.intent === 'unsubscribe'),
    stage: past.at(-1)?.stage ?? 'initial_outreach',
    withPerson: past.some((r) => r.status === 'needs_human'),
  };
  const decision = await sellbirdReply(offer, lead, { id: reply.id, text: reply.text }, history, { env: deps.env, fetch: deps.fetch });
  if (!decision || decision.error) return null;

  const answeredAlready = thread.some((m) => m.ours && m.at > reply.at);
  const interest = INTEREST[decision.intent];
  let action = 'RECORDED';
  let detail = '';
  let answerEmailId: string | null = null;

  if (interest !== undefined && reply.campaignId) {
    try {
      await instantly(deps, 'POST', '/leads/update-interest-status', { lead_email: reply.lead, interest_value: interest, campaign_id: reply.campaignId });
    } catch (error) {
      detail += `interest status not set (${error instanceof Error ? error.message : String(error)}); `;
    }
  }
  if (decision.intent === 'unsubscribe') {
    try {
      await instantly(deps, 'POST', '/block-lists-entries', { bl_value: reply.lead });
      action = 'SUPPRESSED';
      detail += `opt-out by ${decision.optOut?.rule ?? 'model'}${decision.optOut?.matched ? ` ("${decision.optOut.matched}")` : ''}: on the workspace block list`;
    } catch (error) {
      action = 'FAILED';
      detail += `opt-out NOT on the block list (${error instanceof Error ? error.message : String(error)}); the next pass retries`;
    }
    if (decision.escalations.length) detail += '; complaint or legal wording: the owner reads it';
  } else if (decision.intent === 'escalate' || decision.status === 'needs_human' && !decision.answer) {
    action = 'WITH_OWNER';
    detail += decision.escalations.map((e) => e.reason ?? 'escalated').join('; ') || `intent ${decision.intent}: Sellbird hands this to a person`;
  } else if (decision.intent === 'accepted_offer') {
    action = 'FULFILL';
    detail += `said yes to the offer; deliver ${business.deliverable ?? business.offer.product.entry ?? 'it'}`;
  } else if (!decision.answer) {
    action = decision.intent === 'not_interested' ? 'CLOSED' : 'RECORDED';
    detail += `intent ${decision.intent}, stage ${decision.stage}`;
  } else {
    const ungrounded = ungroundedFigures(decision.answer, [...factsOf(business), ...history.map((h) => h.text), reply.text]);
    const why = !business.answer ? 'Brain does not answer on this campaign (the owner\'s own)'
      : answeredAlready ? 'someone already answered this thread'
      : ungrounded.length ? `it quotes ${ungrounded.join(', ')}, which the business's facts do not state`
      : promisesDeliverable(decision.answer) ? `it promises ${business.deliverable ?? 'something'} a text reply cannot carry`
      : null;
    if (why) {
      action = promisesDeliverable(decision.answer) && business.deliverable ? 'FULFILL' : 'HELD';
      detail += `answer drafted and held: ${why}`;
    } else {
      try {
        const first = signer.split(' ')[0] ?? signer;
        const sent = await instantly(deps, 'POST', '/emails/reply', {
          eaccount: reply.eaccount,
          reply_to_uuid: reply.id,
          subject: /^re:/i.test(reply.subject) ? reply.subject : `Re: ${reply.subject}`,
          body: { html: `${textToHtml(decision.answer)}<p>${escapeHtml(first)}</p>`, text: `${decision.answer}\n\n${first}` },
        });
        answerEmailId = String(sent.id ?? '') || null;
        action = 'ANSWERED';
        detail += `answered (${decision.intent}, stage ${decision.stage}) from ${reply.eaccount.replace(/^[^@]+/, '…')}`;
      } catch (error) {
        action = 'FAILED';
        detail += `answer not sent (${error instanceof Error ? error.message : String(error)})`;
      }
    }
  }

  await recordSalesReply({
    emailId: reply.id, business: business.id, campaignId: reply.campaignId, leadEmail: reply.lead, threadId: reply.threadId || null,
    receivedAt: reply.at || null, replyText: reply.text, intent: decision.intent || 'unknown', stage: decision.stage || '',
    status: decision.status || '', optOut: decision.optOut, escalation: decision.escalations, answer: decision.answer || null,
    action, actionDetail: detail, answerEmailId,
  });
  return { business: business.id, emailId: reply.id, intent: decision.intent, action, detail };
}

/** Every new reply on every business's campaigns, oldest first, at most `limit` a pass. */
export async function workReplies(deps: Deps, limit = REPLIES_PER_PASS): Promise<{ outcomes: ReplyOutcome[]; waiting: number; line: string }> {
  const ids = await campaignIds(deps);
  const outcomes: ReplyOutcome[] = [];
  let waiting = 0;
  let deferred = 0;
  for (const business of SALES_BUSINESSES) {
    for (const name of business.campaigns) {
      const campaign = ids.get(name);
      if (!campaign) continue;
      const received = itemsOf(await instantly(deps, 'GET', `/emails?campaign_id=${campaign.id}&email_type=received&limit=100`))
        .map(mailOf).filter((m) => m.id && m.lead.includes('@')).sort((a, b) => a.at.localeCompare(b.at));
      for (const reply of received) {
        if (await salesReplySeen(reply.id)) continue;
        waiting += 1;
        if (outcomes.length >= limit) continue;
        const thread = reply.threadId
          ? itemsOf(await instantly(deps, 'GET', `/emails?thread_id=${encodeURIComponent(reply.threadId)}&limit=50`)).map(mailOf)
          : [reply];
        const out = await handleOneReply(deps, business, reply, thread.length ? thread : [reply]);
        if (out) {
          outcomes.push(out);
          waiting -= 1;
        } else deferred += 1;
      }
    }
  }
  const tally = new Map<string, number>();
  for (const o of outcomes) tally.set(o.action, (tally.get(o.action) ?? 0) + 1);
  const line = `replies: ${outcomes.length} analysed (${[...tally].map(([k, n]) => `${n} ${k.toLowerCase().replace(/_/g, ' ')}`).join(', ') || 'none'})` +
    `${deferred ? `, ${deferred} left for the next pass (the model did not answer)` : ''}${waiting ? `, ${waiting} still waiting` : ''}`;
  return { outcomes, waiting, line };
}

/* ------------------------------------------------------------------------- */
/* The Neighbor Card's personal variant                                      */
/* ------------------------------------------------------------------------- */

/** The share of new leads the personal variant gets, from the last measured allocation. */
export async function personalShare(business = 'neighbor-card'): Promise<number> {
  const last = await latestSalesLearning(business, 'ALLOCATION');
  const share = Number(last?.detail['personalShare']);
  return Number.isFinite(share) && share >= 0 && share <= 1 ? share : DEFAULT_PERSONAL_SHARE;
}

/** Sellbird's desk for new Neighbor Card leads, or undefined when the agents or a model are not connected. */
export async function personalDesk(env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch): Promise<PersonalDesk | undefined> {
  if (!agentsConfig(env) || !browserModel(env)) return undefined;
  const business = salesBusiness('neighbor-card')!;
  const offer = await offerFor(business);
  const share = await personalShare();
  const research = new Map<string, Awaited<ReturnType<typeof sellbirdResearch>>>();
  return {
    perPass: Math.round(MAX_PERSONAL_PER_PASS * share),
    researchPerPass: Number(env['BRAIN_SALES_RESEARCH_PER_PASS'] ?? 30) || 0,
    async research(lead: PersonalLead) {
      const out = await sellbirdResearch(lead.website, offer, { env, fetch: fetcher, industry: lead.category, source: 'sales desk' });
      if (!out || out.error) return null;
      research.set(lead.email, out);
      const refuse = out.fit && out.fit.score === 0 && out.fit.reasons.some((r) => /do-not-contact/i.test(r)) ? 'do-not-contact' : null;
      const named = out.people.find((p) => p.published && p.email?.toLowerCase() === lead.email);
      return { fit: out.fit?.score ?? null, refuse, greeting: named?.firstName ?? null };
    },
    async write(lead: PersonalLead) {
      const r = research.get(lead.email);
      const named = r?.people.find((p) => p.published && p.email?.toLowerCase() === lead.email);
      const draft = await sellbirdWrite(offer, {
        email: lead.email, firstName: named?.firstName, lastName: named?.lastName, title: named?.title,
        company: lead.name, website: lead.website, industry: lead.category, location: `${lead.town}, PA`,
        description: r?.description, techStack: r?.techStack, observations: r?.observations, published: true,
      }, { env, fetch: fetcher });
      const usable = Boolean(draft?.ok && draft.subject && draft.body);
      const ungrounded = usable ? ungroundedFigures(`${draft!.subject} ${draft!.body}`, [...factsOf(business), ...(r?.facts ?? []), r?.description ?? '']) : [];
      const ok = usable && ungrounded.length === 0;
      await saveSalesLead({
        business: business.id, email: lead.email, domain: rootDomain(lead.website),
        fitScore: r?.fit?.score ?? null, fitReasons: r?.fit?.reasons ?? [], facts: r?.facts ?? [],
        research: r ? { siteName: r.siteName, pagesRead: r.pagesRead, techStack: r.techStack, description: r.description, signals: r.observations.length } : {},
        variant: ok ? 'PERSONAL' : 'TEMPLATE',
        subject: usable ? draft!.subject! : null, body: usable ? draft!.body! : null,
        writeNote: ok ? null : !usable ? draft?.reason ?? 'no draft' : `held: quotes ${ungrounded.join(', ')}, not in the facts`,
      });
      if (!ok) return null;
      const body = /^(hi|hello|hey|dear|good)\b/i.test(draft!.body!.trim()) ? draft!.body! : `Hi ${lead.greeting},\n\n${draft!.body!}`;
      return { subject: draft!.subject!, bodyHtml: textToHtml(body) };
    },
    async template(lead: PersonalLead, note: string) {
      const r = research.get(lead.email);
      if ((await salesLead(business.id, lead.email))?.variant === 'TEMPLATE' && !r) return;
      await saveSalesLead({
        business: business.id, email: lead.email, domain: rootDomain(lead.website),
        fitScore: r?.fit?.score ?? null, fitReasons: r?.fit?.reasons ?? [], facts: r?.facts ?? [],
        research: r ? { siteName: r.siteName, pagesRead: r.pagesRead, techStack: r.techStack, description: r.description, signals: r.observations.length } : {},
        variant: 'TEMPLATE', writeNote: note,
      });
    },
  };
}

/* ------------------------------------------------------------------------- */
/* Learning, deliverability, knowledge                                       */
/* ------------------------------------------------------------------------- */

interface CampaignCounts { sent: number; replies: number; bounced: number; unsubscribed: number; leads: number }

async function counts(deps: Deps, id: string): Promise<CampaignCounts> {
  const rows = (await instantly(deps, 'GET', `/campaigns/analytics?id=${id}`)) as unknown as Record<string, number>[];
  const a = (Array.isArray(rows) ? rows[0] : undefined) ?? {};
  return {
    sent: Number(a.emails_sent_count ?? 0), replies: Number(a.reply_count_unique ?? 0), bounced: Number(a.bounced_count ?? 0),
    unsubscribed: Number(a.unsubscribed_count ?? 0), leads: Number(a.leads_count ?? 0),
  };
}

const POSITIVE = new Set(['interested', 'accepted_offer', 'question']);

/** What the replies say, what the analyst makes of it, and the next allocation. */
export async function learn(deps: Deps, business: SalesBusiness, ids: Map<string, { id: string; status: number }>): Promise<string> {
  const replies = await salesReplies(business.id, 2000);
  const perCampaign: Record<string, CampaignCounts & { positive: number }> = {};
  for (const name of business.campaigns) {
    const c = ids.get(name);
    if (!c) continue;
    const n = await counts(deps, c.id);
    perCampaign[name] = { ...n, positive: replies.filter((r) => r.campaignId === c.id && POSITIVE.has(r.intent)).length };
  }
  const names = Object.keys(perCampaign);
  if (names.length === 0) return `${business.id}: no campaign in the workspace`;
  const intents: Record<string, number> = {};
  for (const r of replies) intents[r.intent] = (intents[r.intent] ?? 0) + 1;
  const total = names.reduce((acc, n) => ({ sent: acc.sent + perCampaign[n]!.sent, replies: acc.replies + perCampaign[n]!.replies, unsub: acc.unsub + perCampaign[n]!.unsubscribed }), { sent: 0, replies: 0, unsub: 0 });
  const report = {
    pipeline: { contacted: total.sent, replied: total.replies, opted_out: total.unsub },
    campaigns: names.map((n) => ({ name: n, reply_count: perCampaign[n]!.replies, interested_count: perCampaign[n]!.positive, prospect_count: perCampaign[n]!.leads })),
    intents,
    stages: replies.reduce<Record<string, number>>((m, r) => ({ ...m, [r.stage]: (m[r.stage] ?? 0) + 1 }), {}),
  };
  const analyst = await sellbirdInsights(report, { env: deps.env, fetch: deps.fetch });
  const asked = replies.filter((r) => POSITIVE.has(r.intent) || r.intent === 'objection').slice(0, 6)
    .map((r) => r.replyText.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('>'))?.slice(0, 140) ?? '').filter(Boolean);
  const notes = [
    ...(asked.length ? [`Recent prospects wrote: ${asked.map((a) => `"${a}"`).join('; ')}. Answer the most common of these up front when the facts allow.`] : []),
    ...((intents['objection'] ?? 0) > 0 ? [`${intents['objection']} objection(s) so far; name the no-risk refund early.`] : []),
  ];
  await recordSalesLearning(business.id, 'ANALYST', { report, insights: analyst?.insights ?? [], perCampaign });
  if (notes.length) await recordSalesLearning(business.id, 'WRITER_FEEDBACK', { notes });
  let allocation = '';
  if (business.personal && names.length === 2) {
    const [template, personal] = [perCampaign[business.campaigns[0]!], perCampaign[business.campaigns[1]!]];
    const share = await personalShare(business.id);
    let next = share;
    let reason = `waiting for ${MIN_SENDS_TO_LEARN} sends on each variant`;
    if (template && personal && template.sent >= MIN_SENDS_TO_LEARN && personal.sent >= MIN_SENDS_TO_LEARN) {
      const rt = template.positive / template.sent;
      const rp = personal.positive / personal.sent;
      if (rp >= rt * 1.25 && rp > 0) { next = Math.min(1, share + 0.25); reason = `personal ${(100 * rp).toFixed(2)}% vs template ${(100 * rt).toFixed(2)}% positive replies per send`; }
      else if (rp <= rt * 0.75) { next = Math.max(0.2, share - 0.25); reason = `personal ${(100 * rp).toFixed(2)}% vs template ${(100 * rt).toFixed(2)}% positive replies per send`; }
      else reason = `no clear difference yet (${(100 * rp).toFixed(2)}% vs ${(100 * rt).toFixed(2)}%)`;
    }
    const leadsByVariant = await salesLeadCounts(business.id);
    await recordSalesLearning(business.id, 'ALLOCATION', { personalShare: next, previous: share, reason, template, personal, leadsByVariant });
    allocation = `; personal share ${share} -> ${next} (${reason})`;
  }
  return `${business.id}: ${total.sent} sent, ${total.replies} replied, ${Object.entries(intents).map(([k, n]) => `${n} ${k}`).join(', ') || 'no analysed replies'}; analyst: ${(analyst?.insights ?? []).length} finding(s)${allocation}`;
}

async function due(business: string, kind: string, periodMs: number, now: number): Promise<boolean> {
  const last = await latestSalesLearning(business, kind);
  return !last || now - Date.parse(last.recordedAt) >= periodMs;
}

/** Sellbird's DNS checks on every domain the businesses' campaigns send from. */
export async function checkDeliverability(deps: Deps, ids: Map<string, { id: string; status: number }>): Promise<string> {
  const domains = new Set<string>();
  for (const business of SALES_BUSINESSES) {
    for (const name of business.campaigns) {
      const c = ids.get(name);
      if (!c) continue;
      const campaign = await instantly(deps, 'GET', `/campaigns/${c.id}`);
      for (const e of (campaign.email_list as string[] | undefined) ?? []) domains.add(String(e).split('@')[1] ?? '');
    }
  }
  const failing: string[] = [];
  const readings: Record<string, unknown> = {};
  for (const domain of [...domains].filter(Boolean)) {
    const out = await sellbirdDeliverability(domain, { env: deps.env, fetch: deps.fetch });
    if (!out) continue;
    readings[domain] = out.checks;
    const bad = out.checks.filter((c) => c.status === 'fail' && !c.unknown).map((c) => c.name);
    if (bad.length) failing.push(`${domain} (${bad.join(', ')})`);
  }
  await recordSalesLearning('workspace', 'DELIVERABILITY', { readings, failing });
  return `deliverability: ${Object.keys(readings).length} sending domain(s) checked${failing.length ? `; ATTENTION ${failing.join('; ')}` : ', none failing'}`;
}

/** Sellbird's trainer over a business's own facts: objections and answers for the reply handler. */
export async function refreshKnowledge(deps: Deps, business: SalesBusiness): Promise<string> {
  const p = business.offer.product;
  const pages = {
    'offer': [`${business.offer.brand}: ${p.name}`, p.description, p.pricing ?? '', ...(p.benefits ?? []), p.entry ? `Free first offer: ${p.entry}` : ''].join('\n'),
    'facts': business.offer.knowledge ?? '',
  };
  const out = await sellbirdKnowledge({ pages }, { env: deps.env, fetch: deps.fetch, source: 'sales desk' });
  if (!out || out['error']) return `${business.id}: knowledge not refreshed (${out ? String(out['error']) : 'no model'})`;
  await recordSalesLearning(business.id, 'KNOWLEDGE', { objections: (out['objections'] as Record<string, unknown>) ?? {}, product: out['product'] ?? {}, icp: out['icp'] ?? {} });
  return `${business.id}: knowledge refreshed`;
}

/* ------------------------------------------------------------------------- */
/* The pass                                                                  */
/* ------------------------------------------------------------------------- */

export async function runSalesDesk(deps: Deps, options: { now?: number; replies?: number } = {}): Promise<{ ok: boolean; lines: string[] }> {
  const now = options.now ?? Date.now();
  const lines: string[] = [];
  let ok = true;
  if (!agentsConfig(deps.env)) return { ok: false, lines: ['the agents service is not connected (BRAIN_AGENTS_URL / BRAIN_AGENTS_KEY): run the Agents workflow with "deploy"'] };
  if (!browserModel(deps.env)) lines.push('no model configured (the RunPod GPU or a named cheap-lane model): replies and writing wait for one');
  let ids = new Map<string, { id: string; status: number }>();
  try {
    ids = await campaignIds(deps);
  } catch (error) {
    return { ok: false, lines: [`Instantly not readable: ${error instanceof Error ? error.message : String(error)}`] };
  }
  try {
    const r = await workReplies(deps, options.replies ?? REPLIES_PER_PASS);
    lines.push(r.line);
    for (const o of r.outcomes) lines.push(`  ${o.business} ${o.intent} -> ${o.action}: ${o.detail}`);
  } catch (error) {
    ok = false;
    lines.push(`replies failed this pass: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const business of SALES_BUSINESSES) {
    if (!business.campaigns.some((n) => ids.has(n))) continue;
    try {
      if (await due(business.id, 'KNOWLEDGE', KNOWLEDGE_PERIOD_MS, now) && business.answer) lines.push(await refreshKnowledge(deps, business));
      if (await due(business.id, 'ANALYST', LEARN_PERIOD_MS, now)) lines.push(await learn(deps, business, ids));
    } catch (error) {
      ok = false;
      lines.push(`${business.id}: learning failed (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  try {
    if (await due('workspace', 'DELIVERABILITY', DELIVERABILITY_PERIOD_MS, now)) {
      const line = await checkDeliverability(deps, ids);
      if (line.includes('ATTENTION')) ok = false;
      lines.push(line);
    }
  } catch (error) {
    lines.push(`deliverability failed (${error instanceof Error ? error.message : String(error)})`);
  }
  await recordIntegrationEvent({ integrationId: AGENTS_INTEGRATION, kind: 'USAGE', state: ok ? 'SALES_DESK_OK' : 'SALES_DESK_ATTENTION', detail: lines.join(' | ').slice(0, 2000), source: 'sales desk' });
  return { ok, lines };
}
