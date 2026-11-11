/**
 * The expansion businesses' outreach, watched every hour on production
 * (`businesses/README.md`): grant prospect reports, federal bid digests and
 * accessibility audits, each sold through its own campaign in the owner's
 * Instantly workspace.
 *
 * A pass only reads. For each campaign it prints Instantly's own counts (sent,
 * replies, bounces, opt-outs) and every reply nobody has answered yet, which is
 * the queue the operator works with `businesses/common/operate.py fulfill`.
 * It says ATTENTION when a campaign is not running, when its bounce rate passes
 * the line a sending reputation does not survive, or when a reply waits
 * unanswered. Nothing about a campaign is stored here: every figure is read
 * back from Instantly each pass.
 *
 * The HTTP client is The Neighbor Card's (`neighborCard.ts`): same key, same
 * retry and backoff.
 */
import { defaultDeps, instantly, itemsOf, type Deps } from './neighborCard.ts';

export interface ExpansionCampaign { business: string; name: string }

/** The campaigns `businesses/common/outreach.py` creates, by the NAME in each business's campaign.py. */
export const EXPANSION_CAMPAIGNS: ExpansionCampaign[] = [
  { business: 'grant-prospects', name: 'Grant Prospects · nonprofits wave 1' },
  { business: 'bid-digest', name: 'Bid Digest · contractors wave 1' },
  { business: 'access-audit', name: 'Accessibility Audit · small business wave 1' },
];

/** Above this share of bounced sends, the pass asks for attention before reputation is lost. */
export const BOUNCE_LIMIT = 0.05;
const AUTO = /out of office|automatic reply|auto-?reply|away from|delivery status|undeliverable|mail delivery/i;

export interface CampaignReading {
  business: string; name: string; id: string | null; status: number | null;
  sent: number; replies: number; bounced: number; unsubscribed: number;
  waiting: { from: string; at: string; preview: string; id: string }[];
  problems: string[];
}

async function findCampaign(deps: Deps, name: string): Promise<Record<string, unknown> | null> {
  const found = itemsOf(await instantly(deps, 'GET', `/campaigns?limit=100&search=${encodeURIComponent(name)}`));
  return found.find((c) => c.name === name) ?? null;
}

/** A reply counts as answered once the thread holds a later message from us. */
async function unanswered(deps: Deps, campaignId: string): Promise<CampaignReading['waiting']> {
  const received = itemsOf(await instantly(deps, 'GET', `/emails?campaign_id=${campaignId}&email_type=received&limit=100`));
  const waiting: CampaignReading['waiting'] = [];
  for (const m of received) {
    const preview = String(m.content_preview ?? '');
    if (AUTO.test(String(m.subject ?? '')) || AUTO.test(preview)) continue;
    const from = String(m.from_address_email ?? '').toLowerCase();
    const at = String(m.timestamp_email ?? '');
    const thread = itemsOf(await instantly(deps, 'GET', `/emails?thread_id=${encodeURIComponent(String(m.thread_id ?? ''))}&limit=50`));
    const ours = thread.some((t) => String(t.timestamp_email ?? '') > at && String(t.from_address_email ?? '').toLowerCase() !== from);
    if (!ours) waiting.push({ from, at, preview: preview.slice(0, 160).replace(/\s+/g, ' '), id: String(m.id ?? '') });
  }
  return waiting;
}

export async function readCampaign(deps: Deps, c: ExpansionCampaign): Promise<CampaignReading> {
  const reading: CampaignReading = { ...c, id: null, status: null, sent: 0, replies: 0, bounced: 0, unsubscribed: 0, waiting: [], problems: [] };
  const campaign = await findCampaign(deps, c.name);
  if (!campaign) {
    reading.problems.push('no campaign in the workspace');
    return reading;
  }
  reading.id = String(campaign.id);
  reading.status = Number(campaign.status ?? NaN);
  if (reading.status !== 1) reading.problems.push(`campaign status ${reading.status}, not running`);
  const rows = (await instantly(deps, 'GET', `/campaigns/analytics?id=${reading.id}`)) as unknown as Record<string, number>[];
  const a = (Array.isArray(rows) ? rows[0] : undefined) ?? {};
  reading.sent = Number(a.emails_sent_count ?? 0);
  reading.replies = Number(a.reply_count_unique ?? 0);
  reading.bounced = Number(a.bounced_count ?? 0);
  reading.unsubscribed = Number(a.unsubscribed_count ?? 0);
  if (reading.sent >= 20 && reading.bounced / reading.sent > BOUNCE_LIMIT) {
    reading.problems.push(`bounce rate ${(100 * reading.bounced / reading.sent).toFixed(1)}% is over ${BOUNCE_LIMIT * 100}%`);
  }
  reading.waiting = await unanswered(deps, reading.id);
  if (reading.waiting.length) reading.problems.push(`${reading.waiting.length} reply(ies) waiting for an answer`);
  return reading;
}

export async function runExpansionOutreach(deps: Deps = defaultDeps(), campaigns: ExpansionCampaign[] = EXPANSION_CAMPAIGNS): Promise<{ ok: boolean; lines: string[]; readings: CampaignReading[] }> {
  const lines: string[] = [];
  const readings: CampaignReading[] = [];
  let ok = true;
  for (const c of campaigns) {
    try {
      const r = await readCampaign(deps, c);
      readings.push(r);
      lines.push(`${c.business}: status ${r.status ?? 'none'}, ${r.sent} sent, ${r.replies} replied, ${r.bounced} bounced, ${r.unsubscribed} opted out`);
      for (const w of r.waiting) lines.push(`  waiting: ${w.at} ${w.from} — ${w.preview} [${w.id}]`);
      if (r.problems.length) {
        ok = false;
        lines.push(`  attention: ${r.problems.join('; ')}`);
      }
    } catch (error) {
      ok = false;
      lines.push(`${c.business}: read failed (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return { ok, lines, readings };
}
