/**
 * The Neighbor Card outreach (`fast-cash/launch-2026-11-11/mailer`): one
 * campaign in the owner's Instantly workspace, kept configured and kept fed.
 *
 * Owner's order, 2026-11-11: get the campaign sending through Instantly, keep
 * finding West Shore businesses that publish an email address, validate and
 * deduplicate them, and feed them in, recovering from ordinary failures without
 * a person. The owner authorized the activation and supplied the publisher's
 * mailing address, which CAN-SPAM requires in every message.
 *
 * One pass (`runNeighborCard`) does three independent things and reports each:
 *
 *  1. SYNC     — writes the sequence, the healthy senders and the daily limit,
 *                then reads the campaign back and checks its shape (V2 lesson:
 *                a 200 once published four blank bodies). Activates a draft;
 *                never resumes a campaign a person or Instantly paused.
 *  2. REFILL   — discovers businesses (the Mechanicsburg Chamber's public
 *                directory and OpenStreetMap), reads each one's own website for
 *                an address it published, keeps only addresses whose domain
 *                receives mail (MX), drops anything already in the workspace,
 *                and adds the rest to the campaign.
 *  3. REPORT   — sends, bounces and leads from Instantly's own records.
 *
 * Fixes carried over from V2's email lookup (`Peyday007/V2`
 * `src/lib/extractEmails.ts`, `docs/build-record.md`):
 *  - vendor and agency addresses in site footers were emailed; the foreign
 *    domain list is V2's plus the ones that leaked here (an ad agency, two
 *    real-estate web platforms);
 *  - a franchise's head-office address was taken for the local business: a
 *    role address read from a location sub-page of a multi-location site is
 *    refused;
 *  - nothing checked an address could receive mail, and the owner's earlier
 *    mailer campaigns bounced 40% and 12% (Airyn Mailer is paused by bounce
 *    protection): every address now needs an MX record;
 *  - the campaign's own daily cap throttled every inbox ("why only 4 per
 *    inbox"): the limit is the healthy senders' combined limit, read each pass;
 *  - the refill was silent when it declined to work: every exit path returns a
 *    line saying why, and the workflow publishes it.
 *
 * Nothing here holds a secret: the Instantly key is read from the deployment's
 * environment by `secretValue`, as the provider does (§54, §94).
 */
import { promises as dns } from 'node:dns';
import { secretValue } from './providers/config.ts';
import { INSTANTLY_API } from './providers/instantly.ts';
import type { V2Place } from '../integrations/v2Bridge.ts';
import {
  agentsConfig, browserContact, browserModel, pickBrowser, pickSellbird, sellbirdContacts,
  type BrowserContact, type SellbirdContacts,
} from '../agents/client.ts';

export const CAMPAIGN_NAME = 'Neighbor Card · Camp Hill Jan 2027';
export const PUBLISHER = 'Peyton Rosser';
export const PUBLISHER_PHONE = '313-671-6425';
/** Owner-supplied 2026-11-11; the ZIP is the Census geocoder's match for the street. */
export const PUBLISHER_ADDRESS = '1326 Selden St, Detroit, MI 48201';

const HEALTHY_STATUS = 1;
const DEAD_WARMUP = new Set([-1, -3]);

/* ------------------------------------------------------------------ */
/* The sequence                                                       */
/* ------------------------------------------------------------------ */

const SIGN = `<p>— {{sendingAccountFirstName}}, The Neighbor Card<br>Published by ${PUBLISHER} · ${PUBLISHER_PHONE} · ${PUBLISHER_ADDRESS}</p>`;

export const STEPS: { subject: string; body: string; delayDays: number }[] = [
  {
    subject: 'A January postcard to 4,944 Camp Hill homes, one {{category_lc}} spot',
    delayDays: 3,
    body: `<p>Hi {{greeting}},</p>
<p>We're putting together <b>The Neighbor Card</b>, a big 9×12 postcard of local offers that USPS delivers to <b>4,944 homes in Camp Hill &amp; East Hampden</b> on <b>January 4</b>. That's the week people {{january_angle}}.</p>
<p><b>Where the homes are</b> (11 whole USPS carrier routes in 17011, homes only):</p>
<ul><li>Camp Hill borough: 2,804 homes (57%)</li><li>Hampden Twp: 1,565 (32%)</li><li>East Pennsboro Twp: 431 (9%)</li><li>Lemoyne: 140 (3%)</li></ul>
<ul><li><b>One {{category_lc}} per card.</b> The spot is yours if you take it first.</li>
<li><b>$295 for a standard spot</b> (about 6¢ a home), and we design the ad for free.</li>
<li><b>No risk to you.</b> It prints only if 10 of the 22 ad cells are paid by Dec 9. Otherwise you get a full refund by Dec 11.</li></ul>
<p>Reply "card" and we'll send you the front and back of the actual card, the route map and the one-page rate card. Or should we just hold the {{category_lc}} spot for you?</p>
${SIGN}<p><i>This is an advertising offer. Reply "no thanks" and we won't contact you again.</i></p>`,
  },
  {
    subject: 'Re: A January postcard to 4,944 Camp Hill homes',
    delayDays: 5,
    body: `<p>Hi {{greeting}}, a quick follow-up with the one number most people ask about:</p>
<p>At $295, {{payback}} pays for the spot. The card goes to 4,944 homes with a USPS-counted median household income of about $109k.</p>
<p>The {{category_lc}} spot is still open. Should we send the 2-minute order form?</p>
${SIGN}<p><i>Reply "no thanks" to opt out.</i></p>`,
  },
  {
    subject: 'Closing the {{category_lc}} spot on the Camp Hill card',
    delayDays: 0,
    body: `<p>Hi {{greeting}}, last note from us on this. We're filling the January card's remaining categories this week. If it isn't for you this time, no problem, and we'll leave you alone.</p>
<p>If you'd like the {{category_lc}} spot, reply "yes" and we'll send the order form and a secure payment link. You're still covered by the full refund if the card doesn't fill by Dec 9.</p>
${SIGN}<p><i>Reply "no thanks" to opt out.</i></p>`,
  },
];

export function campaignDefinition(senders: string[], dailyLimit: number): Record<string, unknown> {
  return {
    campaign_schedule: {
      schedules: [{ name: 'Weekdays ET', timing: { from: '09:00', to: '16:00' }, days: { '1': true, '2': true, '3': true, '4': true, '5': true }, timezone: 'America/Detroit' }],
    },
    sequences: [{ steps: STEPS.map((s) => ({ type: 'email', delay: s.delayDays, variants: [{ subject: s.subject, body: s.body }] })) }],
    email_list: senders,
    daily_limit: dailyLimit,
    stop_on_reply: true,
    stop_on_auto_reply: false,
    stop_for_company: true,
    insert_unsubscribe_header: true,
    link_tracking: false,
    open_tracking: false,
  };
}

/** What the campaign must look like after a write, or the reason it does not. */
export function shapeProblems(campaign: Record<string, unknown>, senders: string[], dailyLimit: number): string[] {
  const problems: string[] = [];
  const steps = ((campaign.sequences as { steps?: { variants?: { subject?: string; body?: string }[] }[] }[] | undefined)?.[0]?.steps) ?? [];
  if (steps.length !== STEPS.length) problems.push(`${steps.length} steps, expected ${STEPS.length}`);
  steps.forEach((step, i) => {
    const v = step.variants?.[0];
    if (!v?.subject?.trim()) problems.push(`step ${i + 1} has no subject`);
    if (!v?.body || (v.body.match(/<p>/g) ?? []).length < 2) problems.push(`step ${i + 1} body is blank or fused into one paragraph`);
    if (v?.body && !v.body.includes(PUBLISHER_ADDRESS)) problems.push(`step ${i + 1} lacks the mailing address`);
  });
  const list = [...((campaign.email_list as string[] | undefined) ?? [])].sort();
  if (list.join(',') !== [...senders].sort().join(',')) problems.push(`senders read back as ${list.length}, expected ${senders.length}`);
  if (campaign.daily_limit !== dailyLimit) problems.push(`daily limit reads ${String(campaign.daily_limit)}, expected ${dailyLimit}`);
  return problems;
}

/* ------------------------------------------------------------------ */
/* Instantly, with ordinary failures retried                          */
/* ------------------------------------------------------------------ */

type Fetch = typeof fetch;
export interface Deps {
  fetch: Fetch;
  env: NodeJS.ProcessEnv;
  sleep: (ms: number) => Promise<void>;
  resolveMx: (domain: string) => Promise<boolean | null>;
  log: (line: string) => void;
  /**
   * Google Places through V2's signed bridge (§103), metered against the
   * registry's daily ceiling. Absent when the pass has no metered source; the
   * chamber and the map still run.
   */
  places?: (textQuery: string) => Promise<V2Place[]>;
  /**
   * The open-source agents (§104), asked only about a site the plain reader
   * found no address on: Sellbird (who decides, what the site publishes), then
   * Browser Use for a site that reads as a shell. Absent when the agents app
   * is not connected; refill is then exactly as before.
   */
  agents?: RefillAgents;
}

export interface RefillAgents {
  sellbird: (website: string) => Promise<SellbirdContacts | null>;
  browser: ((website: string) => Promise<BrowserContact | null>) | null;
  /** Sellbird reads per pass (each is up to ten page requests). */
  sellbirdPerPass: number;
  /** Browser tasks per pass (each is a minute or more of the GPU and a Chromium). */
  browserPerPass: number;
}

export function defaultAgents(env: NodeJS.ProcessEnv = process.env): RefillAgents | undefined {
  if (!agentsConfig(env)) return undefined;
  return {
    sellbird: (website) => sellbirdContacts(website, { env }),
    browser: browserModel(env) ? (website) => browserContact(website, { env }) : null,
    sellbirdPerPass: Number(env['BRAIN_AGENTS_SELLBIRD_PER_PASS'] ?? 40) || 0,
    browserPerPass: Number(env['BRAIN_AGENTS_BROWSER_PER_PASS'] ?? 2) || 0,
  };
}

export function defaultDeps(): Deps {
  return {
    fetch: (url, init) => fetch(url, init),
    env: process.env,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    resolveMx: (domain) => hasMailServer(domain),
    log: (line) => console.log(line),
  };
}

/**
 * Does the domain publish a mail server? `true`/`false` only on an answer;
 * `null` when no resolver answered, which is not a "no" (§39): the address is
 * left for the next pass rather than refused. DNS-over-HTTPS first, because a
 * container's own resolver can answer "no data" for every domain (this
 * session's sandbox did, which refused every address on the first pass); the
 * system resolver only when that cannot be reached.
 */
export async function hasMailServer(domain: string, fetcher: Fetch = fetch): Promise<boolean | null> {
  try {
    const res = await fetcher(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=MX`, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const body = (await res.json()) as { Status?: number; Answer?: { type?: number; data?: string }[] };
      if (body.Status === 3) return false;
      if (body.Status === 0) return (body.Answer ?? []).some((a) => a.type === 15 && !/\s\.$/.test(a.data ?? ''));
    }
  } catch {
    /* fall through to the system resolver */
  }
  try {
    const rows = await Promise.race([dns.resolveMx(domain), new Promise<never>((_, no) => setTimeout(() => no(new Error('timeout')), 8000))]);
    return rows.some((r) => r.exchange && r.exchange !== '.');
  } catch (error) {
    const code = (error as { code?: string }).code;
    return code === 'ENOTFOUND' ? false : null;
  }
}

class InstantlyError extends Error {}

/** 429 and 5xx and network errors are retried with backoff (Retry-After honoured); other refusals are not. */
export async function instantly(deps: Deps, method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<Record<string, unknown>> {
  const key = secretValue('INSTANTLY_API_KEY', deps.env);
  if (!key) throw new InstantlyError('INSTANTLY_API_KEY is not configured');
  let wait = 2000;
  for (let attempt = 1; ; attempt += 1) {
    let status = 0;
    let text = '';
    let retryAfter = 0;
    try {
      const res = await deps.fetch(`${INSTANTLY_API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${key}`, 'User-Agent': 'brain-neighbor-card/1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      status = res.status;
      text = await res.text();
      retryAfter = Number(res.headers.get('retry-after')) * 1000 || 0;
      if (res.ok) return text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch (error) {
      text = error instanceof Error ? error.message : String(error);
    }
    const retryable = status === 0 || status === 429 || status >= 500;
    if (!retryable || attempt >= 5) throw new InstantlyError(`${method} ${path}: ${status || 'no answer'} ${text.slice(0, 200)}`);
    await deps.sleep(Math.max(retryAfter, wait));
    wait *= 2;
  }
}

export function itemsOf(answer: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(answer.items) ? (answer.items as Record<string, unknown>[]) : [];
}

export async function healthySenders(deps: Deps): Promise<{ emails: string[]; dailyCapacity: number }> {
  const rows = itemsOf(await instantly(deps, 'GET', '/accounts?limit=100'));
  const healthy = rows.filter((a) => a.status === HEALTHY_STATUS && !DEAD_WARMUP.has(Number(a.warmup_status)));
  return {
    emails: healthy.map((a) => String(a.email)),
    dailyCapacity: healthy.reduce((sum, a) => sum + (Number(a.daily_limit) || 0), 0),
  };
}

async function findCampaign(deps: Deps): Promise<Record<string, unknown> | null> {
  const rows = itemsOf(await instantly(deps, 'GET', `/campaigns?limit=100&search=${encodeURIComponent(CAMPAIGN_NAME)}`));
  return rows.find((c) => c.name === CAMPAIGN_NAME) ?? null;
}

/** Instantly v2 campaign status: 0 draft, 1 active, 2 paused, 3 completed, -1 accounts unhealthy, -2 bounce protection, -99 suspended. */
const STATUS_WORDS: Record<number, string> = { 0: 'draft', 1: 'active', 2: 'paused', 3: 'completed', 4: 'running subsequences', [-1]: 'accounts unhealthy', [-2]: 'paused by bounce protection', [-99]: 'suspended' };

export async function syncCampaign(deps: Deps): Promise<{ id: string; status: number; senders: number; dailyCapacity: number; line: string }> {
  const campaign = await findCampaign(deps);
  if (!campaign) throw new InstantlyError(`no campaign named "${CAMPAIGN_NAME}" in the workspace`);
  const id = String(campaign.id);
  const { emails, dailyCapacity } = await healthySenders(deps);
  if (emails.length === 0) throw new InstantlyError('no healthy sending account in the workspace');
  await instantly(deps, 'PATCH', `/campaigns/${id}`, campaignDefinition(emails, dailyCapacity));
  let back = await instantly(deps, 'GET', `/campaigns/${id}`);
  const problems = shapeProblems(back, emails, dailyCapacity);
  if (problems.length) throw new InstantlyError(`the campaign did not read back as written: ${problems.join('; ')}`);
  let status = Number(back.status);
  if (status === 0) {
    await instantly(deps, 'POST', `/campaigns/${id}/activate`, {});
    back = await instantly(deps, 'GET', `/campaigns/${id}`);
    status = Number(back.status);
  }
  const word = STATUS_WORDS[status] ?? `status ${status}`;
  const note = status === 1 ? '' : status === 0 ? ' (activation did not take)' : ' — not resumed automatically: a person or Instantly stopped it';
  return { id, status, senders: emails.length, dailyCapacity, line: `campaign ${word}${note}; ${emails.length} healthy senders, ${dailyCapacity}/day combined` };
}

/** Every lead in the campaign (emails and website domains), for de-duplication. */
export async function campaignLeads(deps: Deps, campaignId: string): Promise<{ emails: Set<string>; domains: Set<string> }> {
  const emails = new Set<string>();
  const domains = new Set<string>();
  let after: string | undefined;
  for (let page = 0; page < 50; page += 1) {
    const answer = await instantly(deps, 'POST', '/leads/list', { campaign: campaignId, limit: 100, ...(after ? { starting_after: after } : {}) });
    const rows = itemsOf(answer);
    for (const r of rows) {
      if (r.email) {
        emails.add(String(r.email).toLowerCase());
        domains.add(rootDomain(String(r.email).split('@')[1] ?? ''));
      }
      if (r.website) domains.add(rootDomain(String(r.website)));
    }
    after = typeof answer.next_starting_after === 'string' ? answer.next_starting_after : undefined;
    if (!after || rows.length === 0) break;
  }
  return { emails, domains };
}

/* ------------------------------------------------------------------ */
/* Finding a published address (ported from V2, with its fixes)       */
/* ------------------------------------------------------------------ */

const FOREIGN_DOMAINS = [
  'wixpress.com', 'wix.com', 'squarespace.com', 'godaddy.com', 'weebly.com', 'shopify.com', 'wordpress.com', 'webflow.com', 'duda.co', 'b12.io',
  'hubspot.com', 'mailchimp.com', 'constantcontact.com', 'podium.com', 'birdeye.com', 'yext.com', 'thryv.com', 'housecallpro.com', 'jobber.com',
  'servicetitan.com', 'angi.com', 'homeadvisor.com', 'yelp.com', 'thumbtack.com', 'google.com', 'googlemail.com', 'facebook.com', 'instagram.com',
  'sentry.io', 'cloudflare.com', 'example.com', 'domain.com', 'email.com', 'yourdomain.com',
  // Leaked into this campaign's first pull (2026-11-11): an ad agency and two real-estate web platforms.
  'level.agency', 'moxiworks.com', 'moatable.com',
  // Other platforms that sign small-business sites.
  'popmenu.com', 'toasttab.com', 'getbento.com', 'mindbodyonline.com', 'vagaro.com', 'squareup.com', 'square.site', 'officite.com', 'prosites.com',
  'godaddysites.com', 'websitepro.hosting', 'scorpion.co', 'patientpop.com', 'weave.com', 'lighthouse360.com', 'sesamecommunications.com',
  'boomtownroi.com', 'kvcore.com', 'placester.com', 'realtor.com', 'zillow.com', 'chamberofcommerce.com', 'growthzoneapp.com', 'micronetonline.com',
];
const JUNK_LOCAL = new Set(['noreply', 'noreply', 'donotreply', 'postmaster', 'abuse', 'webmaster', 'hostmaster', 'mailerdaemon', 'bounce', 'bounces', 'unsubscribe', 'privacy', 'legal', 'dpo', 'security', 'spam', 'test', 'example', 'user', 'name', 'youremail', 'email', 'yourname', 'john', 'johndoe', 'jane', 'janedoe']);
const ROLE_LOCAL = new Set(['info', 'contact', 'hello', 'hi', 'office', 'admin', 'sales', 'service', 'support', 'enquiries', 'inquiries', 'bookings', 'booking', 'schedule', 'scheduling', 'dispatch', 'team', 'help', 'customerservice', 'accounts', 'accounting', 'billing', 'estimates', 'quotes', 'jobs', 'careers', 'hr', 'mail', 'general', 'reception', 'frontdesk', 'main']);
const EMAIL_RE = /\b[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@[A-Za-z0-9][A-Za-z0-9.-]{0,252}\.[A-Za-z]{2,24}\b/g;
const FILE_ENDINGS = /\.(png|jpe?g|gif|svg|webp|css|js|mjs|json|woff2?|ico|pdf|mp4|avif)$/i;

export function rootDomain(host: string): string {
  const clean = (host || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]!.split(':')[0]!;
  const parts = clean.split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const last = parts[parts.length - 1]!;
  const second = parts[parts.length - 2]!;
  if (last.length === 2 && second.length <= 3) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

export function isPlausibleEmail(email: string): boolean {
  if (FILE_ENDINGS.test(email)) return false;
  const at = email.indexOf('@');
  if (at <= 0) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || !domain.includes('.')) return false;
  if (/^\d+$/.test(domain.split('.').pop() ?? '')) return false;
  if (JUNK_LOCAL.has(local.toLowerCase().replace(/[._-]/g, ''))) return false;
  const root = rootDomain(domain);
  return !FOREIGN_DOMAINS.some((d) => root === d || root.endsWith(`.${d}`));
}

function kindOf(local: string): 'personal' | 'role' | 'generic' {
  const bare = local.toLowerCase().replace(/[._-]/g, '');
  if (ROLE_LOCAL.has(bare)) return 'role';
  if (/^[a-z]+([._-][a-z]+)?$/i.test(local) && local.length <= 24) return 'personal';
  return 'generic';
}

function stripHtml(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#64;|&#x40;/gi, '@').replace(/\s+/g, ' ');
}

function deobfuscate(text: string): string {
  return text.replace(/\s*[([]\s*at\s*[)\]]\s*/gi, '@').replace(/\s*[([]\s*dot\s*[)\]]\s*/gi, '.');
}

export interface Found { email: string; kind: 'personal' | 'role' | 'generic'; confidence: number; sourceUrl: string }

/** Addresses published on one page, scored as V2 scores them (mailto and on-domain count; nothing is constructed). */
export function extractEmails(html: string, pageUrl: string, siteDomain: string): Found[] {
  const site = rootDomain(siteDomain || pageUrl);
  const found = new Map<string, Found>();
  const consider = (raw: string, fromMailto: boolean) => {
    let email = raw.trim().toLowerCase().replace(/[.,;:)\]]+$/, '');
    try { email = decodeURIComponent(email); } catch { /* keep as read */ }
    if (!isPlausibleEmail(email)) return;
    const local = email.slice(0, email.indexOf('@'));
    const onDomain = rootDomain(email.slice(email.indexOf('@') + 1)) === site;
    const confidence = Math.min(0.98, (onDomain ? 0.7 : 0.4) + (fromMailto ? 0.25 : 0));
    const prior = found.get(email);
    if (prior && prior.confidence >= confidence) return;
    found.set(email, { email, kind: kindOf(local), confidence, sourceUrl: pageUrl });
  };
  for (const m of html.matchAll(/href\s*=\s*["']\s*mailto:([^"'?>\s]+)/gi)) consider(m[1]!, true);
  for (const raw of deobfuscate(stripHtml(html)).match(EMAIL_RE) ?? []) consider(raw, false);
  return [...found.values()];
}

/** The one address to use, or none: a named person beats a role account; below 0.6 is a likely bounce. */
export function bestEmail(candidates: Found[]): Found | null {
  const usable = candidates.filter((c) => c.confidence >= 0.6);
  const rank = (c: Found) => c.confidence + (c.kind === 'personal' ? 0.15 : c.kind === 'role' ? 0.05 : 0);
  return usable.sort((a, b) => rank(b) - rank(a))[0] ?? null;
}

/** A location page on a multi-location site: a role address there is usually the head office's. */
export function isLocationSubpage(website: string): boolean {
  try {
    return new URL(website).pathname.split('/').filter(Boolean).length >= 2;
  } catch {
    return false;
  }
}

const PAGES = ['', '/contact', '/contact-us', '/about', '/about-us', '/contactus'];

async function getPage(deps: Deps, url: string): Promise<{ url: string; html: string } | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await deps.fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; neighbor-card-contact-lookup)' }, redirect: 'follow', signal: AbortSignal.timeout(12_000) });
      if (res.status === 404 || res.status === 410) return null;
      if (!res.ok) {
        if (res.status >= 500 || res.status === 429) { await deps.sleep(1500); continue; }
        return null;
      }
      const type = res.headers.get('content-type') ?? '';
      if (type && !type.includes('html')) return null;
      return { url: res.url || url, html: (await res.text()).slice(0, 800_000) };
    } catch {
      await deps.sleep(1000);
    }
  }
  return null;
}

export async function findPublishedEmail(deps: Deps, website: string): Promise<Found | null> {
  const base = website.replace(/\/+$/, '');
  const site = rootDomain(base);
  const all: Found[] = [];
  for (const path of PAGES) {
    const page = await getPage(deps, base + path);
    if (!page) continue;
    all.push(...extractEmails(page.html, page.url, site));
    const best = bestEmail(all);
    if (best && best.kind === 'personal' && best.confidence >= 0.9) break;
  }
  let best = bestEmail(all);
  if (best && best.kind !== 'personal' && isLocationSubpage(website)) best = null;
  return best;
}

/* ------------------------------------------------------------------ */
/* Discovery                                                          */
/* ------------------------------------------------------------------ */

export interface Candidate { name: string; website: string; category: string; town: string; sourceUrl: string }

/** Card category label, and the two lines the sequence fills in for it. */
const CATEGORY: Record<string, { label: string; payback: string; angle: string }> = {
  auto: { label: 'auto service', payback: 'one winter service and tire job', angle: 'deal with winter car trouble' },
  contractor: { label: 'home contractor', payback: 'one spring project booked in January', angle: 'plan the projects they put off' },
  finance: { label: 'insurance and finance', payback: 'one new household policy or client', angle: 'review insurance, taxes and money for the new year' },
  health: { label: 'health practice', payback: 'one new patient', angle: 'book the appointments they put off' },
  dental: { label: 'dentist', payback: 'one new patient', angle: 'use their reset dental benefits' },
  home: { label: 'home service', payback: 'one service call', angle: 'deal with the house after the holidays' },
  legal: { label: 'law office', payback: 'one new client', angle: 'get wills, estates and paperwork in order' },
  personal: { label: 'salon and spa', payback: 'a handful of new clients', angle: 'book something for themselves' },
  pets: { label: 'pet care', payback: 'a couple of new pet families', angle: 'catch up on vet visits and grooming' },
  realestate: { label: 'real estate', payback: 'one listing appointment', angle: 'start planning a spring move' },
  restaurant: { label: 'restaurant', payback: 'a few new regular tables', angle: 'look for a night out after the holidays' },
  retail: { label: 'local shop', payback: 'a few new regular customers', angle: 'spend gift cards and holiday money' },
  fitness: { label: 'fitness and recreation', payback: 'a couple of new members', angle: 'join a gym' },
};

/** Mechanicsburg Chamber directory categories (public GrowthZone pages) → card category. */
const CHAMBER_CATEGORIES: [string, keyof typeof CATEGORY][] = [
  ['automotive-marine-4', 'auto'], ['construction-equipment-contractors-7', 'contractor'], ['finance-insurance-10', 'finance'],
  ['health-care-11', 'health'], ['home-garden-12', 'home'], ['legal-14', 'legal'], ['personal-services-care-17', 'personal'],
  ['pets-veterinary-18', 'pets'], ['real-estate-moving-storage-20', 'realestate'], ['restaurants-food-beverages-22', 'restaurant'],
  ['shopping-specialty-retail-23', 'retail'], ['sports-recreation-24', 'fitness'],
];
/**
 * Public GrowthZone chamber directories whose members sell to Camp Hill and
 * Hampden households. Both use GrowthZone's shared category slugs, so one
 * reader covers both; each pass reads several (chamber × category) pairs.
 */
export const CHAMBERS = ['https://business.mechanicsburgchamber.org', 'https://business.carlislechamber.org'];
export const CHAMBER_PAIRS: { base: string; slug: string; key: keyof typeof CATEGORY }[] = CHAMBER_CATEGORIES.flatMap(([slug, key]) =>
  CHAMBERS.map((base) => ({ base, slug, key })),
);
/** Towns whose businesses sell to Camp Hill & Hampden households. */
const TOWNS = /camp hill|mechanicsburg|lemoyne|new cumberland|enola|wormleysburg|shiremanstown|harrisburg|hampden|summerdale|dillsburg|boiling springs|carlisle|hummelstown|linglestown|paxtang|penbrook|steelton|highspire|middletown|marysville|grantham|lewisberry|etters/i;

const decode = (s: string) => s.replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim();

/**
 * A GrowthZone member page, in either of its two layouts: the older one
 * (`itemprop="url" href`, `mn-cityspan`, `<h1 itemprop="name">`, Mechanicsburg)
 * and the newer one (an anchor whose click is `MemberWebsite`, `addressLocality`,
 * `<meta itemprop="name">`, Carlisle). Reading only the first found nobody in
 * the second.
 */
export function chamberMember(html: string): { website?: string; town: string; name: string } {
  const anchor = [...html.matchAll(/<a\s[^>]*>/g)].map((m) => m[0]).find((tag) => /MemberWebsite|itemprop="url"/.test(tag) && /href="https?:\/\/|href="www\./.test(tag));
  const website = anchor ? /href="([^"]+)"/.exec(anchor)?.[1] : undefined;
  const town = decode(/class="mn-cityspan">([^<]*)/.exec(html)?.[1] ?? /itemprop="addressLocality">([^<]*)/.exec(html)?.[1] ?? '');
  const name = decode(/<h1 itemprop="name">([^<]*)/.exec(html)?.[1] ?? /<meta itemprop="name" content="([^"]*)"/.exec(html)?.[1] ?? '');
  return { website, town, name };
}

export async function discoverChamber(deps: Deps, slug: string, key: keyof typeof CATEGORY, base: string = CHAMBERS[0]!): Promise<Candidate[]> {
  const list = await getPage(deps, `${base}/list/ql/${slug}`);
  if (!list) return [];
  const prefix = `${base}/list/member/`;
  const members = [...new Set([...list.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!).filter((u) => u.startsWith(prefix)))];
  const rows = await pool(members, 6, async (url): Promise<Candidate | null> => {
    const page = await getPage(deps, url);
    if (!page) return null;
    const { website, town, name } = chamberMember(page.html);
    if (!website || !name || !TOWNS.test(town)) return null;
    return { name, website: website.startsWith('http') ? website : `http://${website}`, category: key, town, sourceUrl: url };
  });
  return rows.filter((r): r is Candidate => r !== null);
}

/** OpenStreetMap features with a website, in one West Shore tile; brand chains are left out (their sites answer for head office). */
/**
 * The commercially relevant area: everywhere a Camp Hill household drives to
 * for a dentist, a mechanic or a dinner — the West Shore, Harrisburg and its
 * eastern suburbs, Mechanicsburg out to Carlisle, and down to Dillsburg — as a
 * grid of 0.06° × 0.08° tiles, nearest first; every hourly pass reads three, so
 * the whole grid is covered about twice a day. Owner's order, 2026-11-11: "Search the
 * entire commercially relevant area, not just the original prospect list."
 */
export const OSM_TILES: string[] = (() => {
  const tiles: { box: string; d: number }[] = [];
  for (let s = 40.08; s < 40.38; s += 0.06) {
    for (let w = -77.28; w < -76.66; w += 0.08) {
      const n = s + 0.06;
      const e = w + 0.08;
      const d = Math.hypot((s + n) / 2 - 40.235, ((w + e) / 2 + 76.93) * 0.77);
      tiles.push({ box: `${s.toFixed(2)},${w.toFixed(2)},${n.toFixed(2)},${e.toFixed(2)}`, d });
    }
  }
  return tiles.sort((a, b) => a.d - b.d).map((t) => t.box);
})();
const OSM_KEY: [RegExp, keyof typeof CATEGORY][] = [
  [/^(dentist)$/, 'dental'], [/^(doctors|clinic|physiotherapist|chiropractor|optometrist|healthcare|optician)$/, 'health'], [/^(veterinary|pet|pet_grooming)$/, 'pets'],
  [/^(restaurant|cafe|bar|pub|ice_cream|bakery)$/, 'restaurant'], [/^(hairdresser|beauty|massage|tattoo|cosmetics)$/, 'personal'], [/^(car_repair|tyres|car_wash|car)$/, 'auto'],
  [/^(fitness_centre|sports_centre|dance|martial_arts)$/, 'fitness'], [/^(hvac|plumber|electrician|roofer|carpenter|painter|gardener|builder)$/, 'contractor'],
  [/^(estate_agent)$/, 'realestate'], [/^(insurance|financial|accountant|tax_advisor)$/, 'finance'], [/^(lawyer)$/, 'legal'],
  [/^(florist|jewelry|furniture|hardware|garden_centre|bicycle|gift|clothes|boutique|books|toys)$/, 'retail'],
];
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

export async function discoverOsm(deps: Deps, tile: string): Promise<Candidate[]> {
  const q = `[out:json][timeout:60];(nwr["amenity"]["website"](${tile});nwr["shop"]["website"](${tile});nwr["craft"]["website"](${tile});nwr["office"]["website"](${tile});nwr["leisure"]["website"](${tile});nwr["healthcare"]["website"](${tile}););out tags;`;
  for (const host of OVERPASS) {
    try {
      const res = await deps.fetch(`${host}?data=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(90_000), headers: { 'User-Agent': 'brain-neighbor-card/1' } });
      if (!res.ok) continue;
      const rows = ((await res.json()) as { elements?: { tags?: Record<string, string> }[] }).elements ?? [];
      const out: Candidate[] = [];
      for (const { tags = {} } of rows) {
        if (tags['brand:wikidata'] || !tags.website || !tags.name) continue;
        const kind = tags.amenity ?? tags.shop ?? tags.craft ?? tags.office ?? tags.leisure ?? tags.healthcare ?? '';
        const key = OSM_KEY.find(([re]) => re.test(kind))?.[1];
        if (!key) continue;
        out.push({ name: tags.name, website: tags.website.startsWith('http') ? tags.website : `http://${tags.website}`, category: key, town: tags['addr:city'] ?? '', sourceUrl: `https://www.openstreetmap.org/ (${kind} "${tags.name}")` });
      }
      return out;
    } catch {
      /* the next mirror */
    }
  }
  return [];
}

/**
 * Google Places through V2 (§103): one Text Search a pass, rotating category ×
 * town across the card's whole shopping area, so a day of hourly passes reads
 * 24 different searches inside the registry's ceiling. Places answers chains
 * and businesses without a site too; both are dropped here, the rest go through
 * the same published-address, MX and dedupe gate as every other source.
 */
const PLACES_TOWNS = ['Camp Hill', 'Mechanicsburg', 'Lemoyne', 'New Cumberland', 'Enola', 'Wormleysburg', 'Shiremanstown', 'Hampden Township', 'Carlisle', 'Harrisburg', 'Hummelstown', 'Dillsburg'];
const PLACES_KINDS: [string, keyof typeof CATEGORY][] = [
  ['dentist', 'dental'], ['chiropractor', 'health'], ['veterinarian', 'pets'], ['restaurant', 'restaurant'], ['hair salon', 'personal'],
  ['auto repair', 'auto'], ['gym', 'fitness'], ['HVAC contractor', 'contractor'], ['insurance agency', 'finance'], ['law firm', 'legal'],
  ['florist', 'retail'], ['plumber', 'home'], ['real estate agency', 'realestate'], ['day spa', 'personal'], ['optometrist', 'health'],
  ['orthodontist', 'dental'], ['physical therapy', 'health'], ['med spa', 'personal'], ['nail salon', 'personal'], ['barber shop', 'personal'],
  ['pet groomer', 'pets'], ['electrician', 'contractor'], ['roofing contractor', 'contractor'], ['landscaping', 'home'], ['house cleaning service', 'home'],
  ['pest control', 'home'], ['accountant', 'finance'], ['financial advisor', 'finance'], ['bakery', 'restaurant'], ['cafe', 'restaurant'],
  ['jewelry store', 'retail'], ['furniture store', 'retail'], ['yoga studio', 'fitness'], ['martial arts school', 'fitness'], ['tire shop', 'auto'],
];
export const PLACES_QUERIES: { query: string; key: keyof typeof CATEGORY; town: string }[] = PLACES_KINDS.flatMap(([kind, key]) =>
  PLACES_TOWNS.map((town) => ({ query: `${kind} in ${town}, PA`, key, town })),
);

/**
 * Several Text Searches a pass, beside the other sources, rotating through every kind ×
 * town. The registry's daily ceiling (the spend guard, invariant 38) is the
 * only limit on how many a day; a refused search ends that pass's searches.
 */
export async function discoverPlaces(deps: Deps, slot: number, count = 1): Promise<{ found: Candidate[]; line: string }> {
  if (!deps.places) return { found: [], line: 'Places not used this pass' };
  const picks = Array.from({ length: Math.max(1, count) }, (_, i) => slot * count + i);
  // One after another: each reads the meter after the last one recorded, so the
  // ceiling is never overshot by searches that read it at the same moment.
  // Every other source of the pass still runs beside them.
  const results: { found: Candidate[]; line: string }[] = [];
  for (const n of picks) results.push(await discoverOnePlace(deps, n));
  return { found: results.flatMap((r) => r.found), line: results.map((r) => r.line).join('; ') };
}

async function discoverOnePlace(deps: Deps, slot: number): Promise<{ found: Candidate[]; line: string }> {
  // Interleave kinds and towns so consecutive searches differ in both (7 and the query count are coprime).
  const pick = PLACES_QUERIES[(slot * 7) % PLACES_QUERIES.length]!;
  try {
    if (!deps.places) throw new Error('Places not connected');
    const places = await deps.places(pick.query);
    const found = places
      .filter((p) => p.website && p.name && (p.businessStatus ?? 'OPERATIONAL') === 'OPERATIONAL')
      .map((p) => ({ name: p.name!, website: p.website!.startsWith('http') ? p.website! : `http://${p.website!}`, category: pick.key, town: pick.town, sourceUrl: `Google Places via V2 ("${pick.query}")` }));
    return { found, line: `Places "${pick.query}": ${places.length} businesses, ${found.length} with a website` };
  } catch (error) {
    return { found: [], line: `Places "${pick.query}" not read: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/* ------------------------------------------------------------------ */
/* One pass                                                           */
/* ------------------------------------------------------------------ */

async function pool<T, R>(items: T[], width: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]!);
    }
  }));
  return out;
}

export interface RefillResult { discovered: number; fresh: number; found: number; noMx: number; added: number; line: string; viaAgents?: { sellbirdAsked: number; sellbirdFound: number; browserAsked: number; browserFound: number } }

/**
 * Discovery rotates by the hour so successive passes cover every chamber
 * category and map tile without stored state; the campaign's own leads are the
 * record of what is already in, and `skip_if_in_workspace` keeps anyone the
 * owner's other campaigns hold from being mailed twice.
 */
/** Sources one pass reads, all concurrently. A pass runs every quarter hour (loop.ts). */
export const PER_PASS = { places: 3, chamber: 4, tiles: 6 };

export async function refill(deps: Deps, campaignId: string, options: { slot?: number; maxSites?: number } = {}): Promise<RefillResult> {
  const slot = options.slot ?? Math.floor(Date.now() / 900_000);
  const known = await campaignLeads(deps, campaignId);
  const chamber = Array.from({ length: PER_PASS.chamber }, (_, i) => CHAMBER_PAIRS[(slot * PER_PASS.chamber + i) % CHAMBER_PAIRS.length]!);
  const tiles = Array.from({ length: PER_PASS.tiles }, (_, i) => OSM_TILES[(slot * PER_PASS.tiles + i) % OSM_TILES.length]!);
  const [places, ...batches] = await Promise.all([
    discoverPlaces(deps, slot, PER_PASS.places),
    ...chamber.map((c) => discoverChamber(deps, c.slug, c.key, c.base).then((found) => ({ found, line: '' }))),
    ...tiles.map((t) => discoverOsm(deps, t).then((found) => ({ found, line: '' }))),
  ]).then((all) => [all[0]!, ...all.slice(1).map((b) => b.found)] as const);
  // Places first: its answers are the most complete, so a site it shares with the map is read once, as Places'.
  batches.unshift(places.found);
  const seen = new Set<string>();
  const fresh = batches.flat().filter((c) => {
    const d = rootDomain(c.website);
    if (!d || known.domains.has(d) || seen.has(d) || FOREIGN_DOMAINS.some((f) => d === f || d.endsWith(`.${f}`)) || /facebook|instagram|linkedin|yelp/.test(d)) return false;
    seen.add(d);
    return true;
  }).slice(0, options.maxSites ?? 300);
  let found = 0;
  let noMx = 0;
  let unverified = 0;
  let added = 0;
  const agents = deps.agents;
  let sellbirdLeft = agents?.sellbirdPerPass ?? 0;
  let browserLeft = agents?.browser ? agents.browserPerPass : 0;
  const viaAgents = { sellbirdAsked: 0, sellbirdFound: 0, browserAsked: 0, browserFound: 0 };
  await pool(fresh, 20, async (c) => {
    let hit: Found | null = await findPublishedEmail(deps, c.website);
    let greeting = 'there';
    if (!hit && agents && sellbirdLeft > 0) {
      sellbirdLeft -= 1;
      viaAgents.sellbirdAsked += 1;
      const read = await agents.sellbird(c.website);
      const pick = read ? pickSellbird(read) : null;
      if (pick && isPlausibleEmail(pick.email)) {
        viaAgents.sellbirdFound += 1;
        hit = { email: pick.email, kind: pick.firstName ? 'personal' : 'generic', confidence: 0.9, sourceUrl: pick.sourceUrl };
        if (pick.firstName) greeting = pick.firstName;
      } else if (read && agents.browser && browserLeft > 0 && (read.challenged || read.pagesRead <= 1)) {
        // A shell, a challenge or a one-page site: what a browser can read and plain HTTP cannot.
        browserLeft -= 1;
        viaAgents.browserAsked += 1;
        const seen = pickBrowser(await agents.browser(c.website));
        if (seen && isPlausibleEmail(seen.email) && rootDomain(`https://${seen.email.split('@')[1]!}`) === rootDomain(c.website)) {
          viaAgents.browserFound += 1;
          hit = { email: seen.email, kind: 'generic', confidence: 0.85, sourceUrl: seen.sourceUrl };
        }
      }
    }
    if (!hit) return;
    found += 1;
    if (known.emails.has(hit.email)) return;
    const mx = await deps.resolveMx(hit.email.split('@')[1]!);
    if (mx === null) { unverified += 1; return; }
    if (!mx) { noMx += 1; return; }
    const cat = CATEGORY[c.category]!;
    try {
      await instantly(deps, 'POST', '/leads', {
        campaign: campaignId,
        email: hit.email,
        company_name: c.name,
        website: c.website,
        skip_if_in_workspace: true,
        skip_if_in_campaign: true,
        custom_variables: { greeting, category_lc: cat.label, payback: cat.payback, january_angle: cat.angle, source_url: hit.sourceUrl, found_via: c.sourceUrl.slice(0, 200), town: c.town },
      });
      known.emails.add(hit.email);
      added += 1;
    } catch (error) {
      deps.log(`  lead refused ${hit.email.replace(/^[^@]+/, '…')}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  const discovered = batches.reduce((n, b) => n + b.length, 0);
  const sources = `${places.line}; ${chamber.map((c) => `${new URL(c.base).hostname.split('.')[1]}/${c.slug}`).join(', ')}; map tiles ${tiles.join(', ')} (${batches.slice(1 + chamber.length).reduce((n, b) => n + b.length, 0)} on the map)`;
  const line = fresh.length === 0
    ? `refill: nothing new to read this pass (${discovered} discovered from ${sources}, all already in the campaign or not usable)`
    : `refill: ${discovered} discovered from ${sources}; ${fresh.length} new sites read; ${found} published an address; ${noMx} refused for no mail server; ${unverified} left for the next pass (no resolver answered); ${added} added` +
      (agents ? `; agents: Sellbird ${viaAgents.sellbirdFound}/${viaAgents.sellbirdAsked} found, Browser Use ${viaAgents.browserFound}/${viaAgents.browserAsked} verified` : '');
  return { discovered, fresh: fresh.length, found, noMx, added, line, ...(agents ? { viaAgents } : {}) };
}

/**
 * What the shared mailboxes already carry for the owner's other active
 * campaigns: each one's largest day of sends in the last week, from Instantly's
 * own daily analytics. A sender's daily limit is per mailbox across every
 * campaign, so this is subtracted from the combined limit to give what the
 * Neighbor Card can actually use.
 */
export async function committedElsewhere(deps: Deps, campaignId: string, senders: string[]): Promise<{ committed: number; line: string }> {
  const mine = new Set(senders);
  const others = itemsOf(await instantly(deps, 'GET', '/campaigns?limit=100'))
    .filter((c) => c.id !== campaignId && c.status === 1 && ((c.email_list as string[] | undefined) ?? []).some((e) => mine.has(e)));
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  let committed = 0;
  const parts: string[] = [];
  for (const c of others) {
    const days = (await instantly(deps, 'GET', `/campaigns/analytics/daily?campaign_id=${String(c.id)}&start_date=${since}`)) as unknown as { sent?: number }[];
    const peak = Array.isArray(days) ? days.reduce((m, d) => Math.max(m, Number(d.sent) || 0), 0) : 0;
    committed += peak;
    parts.push(`${String(c.name)} ${peak}/day`);
  }
  return { committed, line: parts.length ? `shared senders also carry: ${parts.join(', ')}` : 'no other active campaign shares these senders' };
}

export async function deliveryReport(deps: Deps, campaignId: string): Promise<{ sent: number; bounced: number; leads: number; replies: number; line: string }> {
  const rows = (await instantly(deps, 'GET', `/campaigns/analytics?id=${campaignId}`)) as unknown as Record<string, number>[];
  const a = (Array.isArray(rows) ? rows[0] : undefined) ?? {};
  const sent = Number(a.emails_sent_count ?? 0);
  const bounced = Number(a.bounced_count ?? 0);
  // Instantly's analytics lead counter lags; the lead list is the record.
  const leads = (await campaignLeads(deps, campaignId)).emails.size;
  const replies = Number(a.reply_count_unique ?? 0);
  return { sent, bounced, leads, replies, line: `delivery: ${sent} sent, ${bounced} bounced, ${replies} replied, ${leads} leads in the campaign (Instantly's records)` };
}

/** Sync, refill and report, each independent: one failing never stops the others. */
export async function runNeighborCard(deps: Deps = defaultDeps(), options: { refill?: boolean; slot?: number; maxSites?: number } = {}): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  let ok = true;
  let id: string | null = null;
  try {
    const sync = await syncCampaign(deps);
    id = sync.id;
    lines.push(sync.line);
    if (sync.status !== 1) ok = false;
    try {
      const { emails } = await healthySenders(deps);
      const shared = await committedElsewhere(deps, sync.id, emails);
      lines.push(`capacity: ${Math.max(0, sync.dailyCapacity - shared.committed)}/day usable of ${sync.dailyCapacity}/day across ${sync.senders} healthy senders (${shared.line})`);
    } catch (error) {
      lines.push(`capacity read failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } catch (error) {
    ok = false;
    lines.push(`sync failed: ${error instanceof Error ? error.message : String(error)}`);
    try { id = String((await findCampaign(deps))?.id ?? '') || null; } catch { /* reported above */ }
  }
  if (id && options.refill !== false) {
    try {
      lines.push((await refill(deps, id, { slot: options.slot, maxSites: options.maxSites })).line);
    } catch (error) {
      lines.push(`refill failed this pass (the next pass retries): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (id) {
    try {
      lines.push((await deliveryReport(deps, id)).line);
    } catch (error) {
      lines.push(`report failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { ok, lines };
}
