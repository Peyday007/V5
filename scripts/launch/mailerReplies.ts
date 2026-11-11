/**
 * Mailer replies: answers the Neighbor Card campaign's prospects so the sale
 * keeps moving without a person reading the unibox.
 *
 * Every run reads the received mail on the campaign, and for each reply that
 * has not been answered yet:
 *
 *   wants the card ("card", "send", "info", a question) → the card's front and
 *     back, route map and rate card as links to the public repository's files
 *   says yes ("yes", "hold it", "sign me up")           → the order form, and the
 *     payment links when the Stripe stage has made them in this run
 *   opts out ("no thanks", "remove me")                → nothing; the campaign
 *     already stops on reply
 *   out of office, or anything else                    → nothing; counted in the
 *     summary for a person
 *
 * "Not answered yet" is read from Instantly itself: a reply is skipped when its
 * thread already holds a manual email (ue_type 3) sent after it. Sending is an
 * external effect with no idempotency key, so a send whose answer is lost is
 * never retried inside a run (§26); the next run reads the thread and decides.
 *
 * The signature (the owner's name, phone and the postal address CAN-SPAM
 * requires) is copied from the campaign's own first step, so no personal
 * detail lives in this repository. Nothing about the campaign is changed.
 *
 * Credential: INSTANTLY_API_KEY, which lives on the production machine (§94),
 * so launch.yml runs this stage there over `flyctl ssh`, as neighbor-card.yml does.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { StageContext, StageResult } from './types.ts';

export const INSTANTLY_API = 'https://api.instantly.ai/api/v2';
export const NEIGHBOR_CARD_CAMPAIGN = 'e4d48b2a-67f4-4f16-9c2b-8e34b0629fc1';
const STAGE = 'mailerReplies';
const KIT = 'fast-cash/launch-2026-11-11/mailer';
const RAW = 'https://raw.githubusercontent.com/Peyday007/V5/production';

export const CARD_FILES = [
  ['Front and back of the January card (PDF)', 'mockup/card-mockup-2-sides.pdf'],
  ['Route map: the homes it reaches', 'mockup/route-map.png'],
  ['One-page rate card (PDF)', 'mockup/rate-card.pdf'],
] as const;

type Json = Record<string, unknown>;
export type Intent = 'OPT_OUT' | 'AUTO' | 'YES' | 'CARD' | 'OTHER';

/** The reply's own words: everything above the quoted original. */
export function ownWords(text: string): string {
  const lines: string[] = [];
  for (const line of text.replace(/\r/g, '').split('\n')) {
    if (/^\s*>/.test(line)) break;
    if (/^\s*On .+(wrote|écrit)/i.test(line) || /^-{2,}\s*Original Message/i.test(line) || /^\s*From:\s/i.test(line)) break;
    lines.push(line);
  }
  return lines.join('\n').trim();
}

export function classify(text: string, subject = ''): Intent {
  const t = ownWords(text).toLowerCase();
  if (/out of (the )?office|auto(matic)?[- ]?reply|currently (closed|away|out)|on vacation|limited access to email/.test(`${t} ${subject.toLowerCase()}`)) return 'AUTO';
  if (/\b(no,? thanks?|no thank you|not interested|unsubscribe|remove (me|us)|take (me|us) off|stop (emailing|contacting)|do ?n[o']t (contact|email)|please stop|pass on)\b/.test(t)) return 'OPT_OUT';
  if (/^\s*no\b(?![, ]+(problem|worries))/.test(t) || /\bno more (emails?|messages?)\b/.test(t)) return 'OPT_OUT';
  if (/\b(hold (it|the|my|our|a|that|us)|i'?m in|we'?re in|sign (me|us) up|count (me|us) in|order form|let'?s do (it|this)|reserve|book (it|me|us)|i'?ll take|we'?ll take)\b/.test(t)) return 'YES';
  if (/\b(card|send|info|information|details|more|sample|see it|look|price|pricing|rates?|cost|how much|example|interested)\b/.test(t) || t.includes('?')) return 'CARD';
  if (/\b(yes|yeah|yep|sure|ok(ay)?)\b/.test(t)) return 'YES';
  return 'OTHER';
}

/**
 * The fillable block of ORDER-FORM-EMAIL.md, embedded because the stage runs on
 * the production machine, whose image carries scripts/ but not the kit
 * (tests/launchMailerReplies.test.ts keeps the two identical).
 */
export const ORDER_FORM = `BUSINESS (legal name):
NAME AS IT SHOULD APPEAR ON THE AD:
CATEGORY (one line, e.g. "family dentistry"):
CONTACT NAME / PHONE / EMAIL:
BUSINESS ADDRESS:

SPACE (pick one):
  [ ] Standard 2.8" x 2.33"        Zone 1 $295   | Both zones $495
  [ ] Double 5.7" x 2.33"          Zone 1 $525   | Both zones $895
  [ ] Back Premium (by address)    Zone 1 $575   | Both zones $975
  [ ] Front Feature (top of front) Zone 1 $625   | Both zones $1,050
ZONE:  [ ] Zone 1 – Camp Hill & East Hampden (4,944 homes)
       [ ] Both zones (+ Hampden Twp West, 9,894 homes)

AD CONTENT (or attach):
  Headline offer:
  Expiry date of the offer (suggest Feb 28, 2027):
  Phone / website / address to print:
  Logo: attached [ ] / use the one on our website [ ]
  Licence or registration number to print (if your trade requires one):

PAY BY:  [ ] card   [ ] bank account (ACH)
I have read the Advertiser Agreement and I agree:  (type your name)`;

export function orderForm(root: string): string {
  const file = path.join(root, KIT, 'ORDER-FORM-EMAIL.md');
  if (!fs.existsSync(file)) return ORDER_FORM;
  const m = /```\n([\s\S]*?)```/.exec(fs.readFileSync(file, 'utf8'));
  if (!m?.[1]) throw new Error('ORDER-FORM-EMAIL.md has no fenced order form');
  return m[1].trimEnd();
}

interface Link { name: string; amount: number; url: string }
/** The Stripe stage's links: from this checkout, or handed to the production machine base64-encoded. */
function paymentLinks(root: string, env: StageContext['env']): Link[] {
  try {
    const b64 = env['LAUNCH_STRIPE_LINKS_B64'];
    const raw = b64 ? Buffer.from(b64, 'base64').toString('utf8') : fs.readFileSync(path.join(root, '.launch-out', 'stripe-links.json'), 'utf8');
    const j = JSON.parse(raw) as { links?: Link[] };
    return (j.links ?? []).filter((l) => l.url);
  } catch { return []; }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function replyBody(intent: 'YES' | 'CARD', root: string, signature: string, env: StageContext['env'] = {}): { html: string; text: string } {
  const sigText = signature.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
  if (intent === 'CARD') {
    const items = CARD_FILES.map(([label, f]) => [label, `${RAW}/${KIT}/${f}`] as const);
    const html =
      `<p>Hi, here it is:</p><ul>${items.map(([l, u]) => `<li><a href="${u}">${esc(l)}</a></li>`).join('')}</ul>` +
      `<p>A standard spot is $295 for 4,944 homes, and I design the ad for free. It prints only if 10 of the 22 ad cells are paid by Dec 9; otherwise everyone is refunded in full by Dec 11.</p>` +
      `<p>Want me to hold your category? Reply "yes" and I'll send the 2-minute order form.</p>${signature}`;
    const text = `Hi, here it is:\n${items.map(([l, u]) => `- ${l}: ${u}`).join('\n')}\n\nA standard spot is $295 for 4,944 homes, and I design the ad for free. It prints only if 10 of the 22 ad cells are paid by Dec 9; otherwise everyone is refunded in full by Dec 11.\n\nWant me to hold your category? Reply "yes" and I'll send the 2-minute order form.\n\n${sigText}`;
    return { html, text };
  }
  const form = orderForm(root);
  const links = paymentLinks(root, env);
  const pay = links.length
    ? { html: `<p>Or pay now to lock the category (secure Stripe checkout):</p><ul>${links.map((l) => `<li><a href="${l.url}">${esc(l.name)}: $${l.amount}</a></li>`).join('')}</ul>`,
        text: `Or pay now to lock the category (secure Stripe checkout):\n${links.map((l) => `- ${l.name}: $${l.amount} ${l.url}`).join('\n')}\n\n` }
    : { html: `<p>As soon as it's back I'll send your secure payment link; the category is locked the moment it's paid.</p>`, text: `As soon as it's back I'll send your secure payment link; the category is locked the moment it's paid.\n\n` };
  const html = `<p>Great, here's the order form. Reply with the blanks filled in:</p><pre>${esc(form)}</pre>${pay.html}<p>The card prints only if 10 of the 22 cells are paid by Dec 9; otherwise you get a full refund by Dec 11.</p>${signature}`;
  const text = `Great, here's the order form. Reply with the blanks filled in:\n\n${form}\n\n${pay.text}The card prints only if 10 of the 22 cells are paid by Dec 9; otherwise you get a full refund by Dec 11.\n\n${sigText}`;
  return { html, text };
}

/** The campaign's signature paragraph(s): from the one naming the card to the end of step 1. */
export function signatureFrom(campaign: Json): string {
  const steps = ((campaign['sequences'] as Json[] | undefined)?.[0]?.['steps'] as Json[] | undefined) ?? [];
  const body = String(((steps[0]?.['variants'] as Json[] | undefined)?.[0]?.['body']) ?? '');
  const at = body.search(/<p>[^<]*The Neighbor Card ·/);
  if (at < 0) throw new Error('campaign step 1 has no "… · The Neighbor Card · …" signature to copy');
  return body.slice(at);
}

class Instantly {
  calls = 0;
  constructor(private readonly ctx: StageContext) {}
  async call(method: 'GET' | 'POST', p: string, body?: unknown): Promise<Json> {
    this.calls++;
    const res = await this.ctx.fetch(`${INSTANTLY_API}${p}`, {
      method,
      headers: { Authorization: `Bearer ${this.ctx.env['INSTANTLY_API_KEY']}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: Json = {};
    try { json = text ? (JSON.parse(text) as Json) : {}; } catch { json = { message: text.slice(0, 200) }; }
    if (!res.ok) throw new Error(`Instantly ${method} ${p.split('?')[0]} → ${res.status}: ${String(json['message'] ?? json['error'] ?? '')}`);
    return json;
  }
}

export async function runMailerReplies(ctx: StageContext): Promise<StageResult> {
  // Local inputs first: a broken kit fails the dry run, not a live reply.
  orderForm(ctx.root);
  // The links point at the public repository; the files are checked where the kit is checked out.
  if (fs.existsSync(path.join(ctx.root, KIT))) {
    for (const [, f] of CARD_FILES) if (!fs.existsSync(path.join(ctx.root, KIT, f))) throw new Error(`missing ${KIT}/${f}`);
  }
  if (ctx.dryRun) return { stage: STAGE, status: 'DONE', detail: 'dry run: order form and 3 card files present; no network', items: [] };

  if (!ctx.env['INSTANTLY_API_KEY']) {
    return {
      stage: STAGE, status: 'NEEDS_OWNER', items: [],
      detail: 'no Instantly key: the campaign sends, but replies wait in the Instantly unibox',
      ownerAction: 'The production machine has no INSTANTLY_API_KEY (§94). It is set there once with `flyctl secrets set INSTANTLY_API_KEY=…`; Brain then answers card requests and order replies every hour.',
    };
  }

  const api = new Instantly(ctx);
  const campaignId = ctx.env['NEIGHBOR_CARD_CAMPAIGN_ID'] || NEIGHBOR_CARD_CAMPAIGN;
  let signature: string;
  try {
    signature = signatureFrom(await api.call('GET', `/campaigns/${campaignId}`));
  } catch (e) {
    return { stage: STAGE, status: 'FAILED', detail: `could not read the campaign: ${(e as Error).message}`, items: [] };
  }

  const received: Json[] = [];
  let after = '';
  for (let page = 0; page < 20; page++) {
    const q = new URLSearchParams({ campaign_id: campaignId, email_type: 'received', limit: '100' });
    if (after) q.set('starting_after', after);
    const r = await api.call('GET', `/emails?${q}`);
    received.push(...(((r['items'] as Json[]) ?? []).filter((e) => e['campaign_id'] === campaignId && Number(e['ue_type']) === 2)));
    after = String(r['next_starting_after'] ?? '');
    if (!after) break;
  }

  // The newest reply per thread is the one to answer.
  const latest = new Map<string, Json>();
  for (const e of received) {
    const t = String(e['thread_id']);
    const prev = latest.get(t);
    if (!prev || String(e['timestamp_email']) > String(prev['timestamp_email'])) latest.set(t, e);
  }

  const counts: Record<string, number> = { CARD: 0, YES: 0, OPT_OUT: 0, AUTO: 0, OTHER: 0, answered: 0 };
  const items: StageResult['items'] = [];
  for (const [thread, e] of latest) {
    const intent = Number(e['is_auto_reply']) === 1 ? 'AUTO' : classify(String((e['body'] as Json | undefined)?.['text'] ?? e['content_preview'] ?? ''), String(e['subject'] ?? ''));
    counts[intent] = (counts[intent] ?? 0) + 1;
    if (intent !== 'CARD' && intent !== 'YES') continue;
    const key = `thread ${thread.slice(-8)} · ${intent === 'CARD' ? 'card sent' : 'order form sent'}`;
    try {
      const t = await api.call('GET', `/emails?${new URLSearchParams({ search: `thread:${thread}`, limit: '50' })}`);
      const answered = ((t['items'] as Json[]) ?? []).some((x) => Number(x['ue_type']) === 3 && String(x['timestamp_email']) > String(e['timestamp_email']));
      if (answered) { counts['answered']!++; continue; }
    } catch (err) {
      items.push({ key, state: 'FAILED', note: `thread unreadable, not answered: ${(err as Error).message}` });
      continue;
    }
    const subject = String(e['subject'] ?? '');
    try {
      await api.call('POST', '/emails/reply', {
        eaccount: e['eaccount'],
        reply_to_uuid: e['id'],
        subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
        body: replyBody(intent, ctx.root, signature, ctx.env),
      });
      items.push({ key, state: 'CREATED' });
    } catch (err) {
      // Unknown outcome: not retried here; the next run reads the thread.
      items.push({ key, state: 'FAILED', note: (err as Error).message });
    }
  }

  const failed = items.filter((i) => i.state === 'FAILED').length;
  const sent = items.length - failed;
  const detail = `${received.length} replies in ${latest.size} threads: ${sent} answered now, ${counts['answered']} answered before; ` +
    `${counts['CARD']} wanted the card, ${counts['YES']} said yes, ${counts['OPT_OUT']} opted out, ${counts['AUTO']} auto-replies, ${counts['OTHER']} for a person to read in the Instantly unibox. ${api.calls} API calls.`;
  return { stage: STAGE, status: failed ? (sent ? 'PARTIAL' : 'FAILED') : 'DONE', detail, items };
}
