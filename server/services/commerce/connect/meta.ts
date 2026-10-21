/**
 * Meta ads (§74): one bounded traffic test per listed product, paused by Brain
 * when it has spent its stop amount with nothing sold.
 *
 * Marketing API v24.0, authenticated with a system-user access token in an
 * `Authorization: Bearer` header — never in a URL. The token needs
 * `ads_management` on the ad account and the Page.
 *
 * ---------------------------------------------------------------------------
 * Built paused, switched on last
 * ---------------------------------------------------------------------------
 *
 * A test is four objects (campaign, ad set, creative, ad). Each is created
 * PAUSED and found again by a name carrying Brain's business id, so a send that
 * dies halfway leaves paused objects that spend nothing, and the retry picks up
 * where it stopped instead of creating a second campaign. Only when all four
 * exist are they switched on. The ad set carries an end time, so a test cannot
 * outrun the days its commitment paid for even if Brain stops answering.
 */
import type {
  AdapterHealth,
  EffectAdapter,
  EffectRequest,
  ReconcileOutcome,
  SendOutcome,
} from '../../effects/adapter.ts';
import { META_PAGE_ENV, META_TOKEN_ENV, adAccountId, adsConfig, secret } from './config.ts';
import { request } from './http.ts';

export const META_GRAPH = 'https://graph.facebook.com/v24.0';
export const META_AD_TEST_ADAPTER = 'meta.ad_test';

type MetaResult = { ok: true; data: any } | { ok: false; unknown: boolean; retryable: boolean; detail: string };

async function meta(method: 'GET' | 'POST', path: string, params: Record<string, unknown> = {}): Promise<MetaResult> {
  const token = secret(META_TOKEN_ENV);
  if (!token) return { ok: false, unknown: false, retryable: false, detail: 'the ad account is not connected' };
  const encode = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) query.set(key, encode(value));
  const answer = await request({
    url: method === 'GET' ? `${META_GRAPH}/${path}?${query.toString()}` : `${META_GRAPH}/${path}`,
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(method === 'POST' ? { body: query.toString() } : {}),
  });
  if (answer.kind === 'UNKNOWN') return { ok: false, unknown: true, retryable: false, detail: answer.reason };
  if (answer.kind === 'REFUSED') {
    return { ok: false, unknown: false, retryable: answer.retryable, detail: answer.detail };
  }
  return { ok: true, data: answer.body };
}

export interface AdTestPayload {
  /** Brain's business id; every object's name carries it. */
  tag: string;
  link: string;
  headline: string;
  message: string;
  imageUrl: string | null;
  dailyBudgetCents: number;
  /** When the ad set stops by itself, ISO-8601. */
  endTime: string;
  countries: string[];
}

function named(tag: string, kind: string): string {
  return `brain:${tag}:${kind}`;
}

async function findByName(edge: string, name: string): Promise<string | null | 'UNKNOWN'> {
  const account = adAccountId();
  if (!account) return 'UNKNOWN';
  const result = await meta('GET', `${account}/${edge}`, {
    fields: 'id,name',
    filtering: [{ field: 'name', operator: 'EQUAL', value: name }],
    limit: 5,
  });
  if (!result.ok) return 'UNKNOWN';
  const found = (Array.isArray(result.data?.data) ? result.data.data : []).find((one: any) => one?.name === name);
  return found?.id ? String(found.id) : null;
}

async function ensure(edge: string, name: string, params: Record<string, unknown>): Promise<string | MetaResult> {
  const existing = await findByName(edge, name);
  if (existing === 'UNKNOWN') return { ok: false, unknown: false, retryable: true, detail: 'Meta did not answer a lookup; nothing new was created' };
  if (existing) return existing;
  const created = await meta('POST', `${adAccountId()}/${edge}`, { name, ...params });
  if (!created.ok) return created;
  return String(created.data?.id ?? '');
}

function failed(result: MetaResult): SendOutcome {
  if (result.ok) return { kind: 'UNCERTAIN', reason: 'Meta answered without an id' };
  if (result.unknown) return { kind: 'UNCERTAIN', reason: result.detail };
  // Everything created so far is PAUSED, so a refused step spends nothing and a
  // retry resumes by name.
  return { kind: 'REJECTED', category: 'PROVIDER_REJECTED', retryable: result.retryable, detail: result.detail };
}

export function createMetaAdTestAdapter(input: { namespace: string }): EffectAdapter {
  return {
    name: META_AD_TEST_ADAPTER,
    effectClass: 'EXTERNAL_RECONCILABLE',
    namespace: input.namespace,
    validate(payload: unknown): Record<string, unknown> {
      const p = (payload ?? {}) as Partial<AdTestPayload>;
      if (typeof p.tag !== 'string' || !/^[A-Za-z0-9_:-]{4,120}$/.test(p.tag)) throw new Error('an ad test needs Brain’s tag');
      if (typeof p.link !== 'string' || !/^https:\/\//.test(p.link)) throw new Error('an ad test needs an https link');
      if (typeof p.headline !== 'string' || !p.headline.trim()) throw new Error('an ad test needs a headline');
      if (typeof p.message !== 'string' || !p.message.trim()) throw new Error('an ad test needs a message');
      if (!Number.isSafeInteger(p.dailyBudgetCents) || (p.dailyBudgetCents as number) <= 0) throw new Error('a daily budget is required');
      if (typeof p.endTime !== 'string' || !Number.isFinite(Date.parse(p.endTime))) throw new Error('an end time is required');
      if (!Array.isArray(p.countries) || p.countries.length === 0) throw new Error('at least one country is required');
      return p as Record<string, unknown>;
    },
    fingerprintInputs(payload) {
      return { tag: payload.tag, dailyBudgetCents: payload.dailyBudgetCents };
    },
    async send(req: EffectRequest): Promise<SendOutcome> {
      const p = req.payload as unknown as AdTestPayload;
      const page = secret(META_PAGE_ENV);
      if (!page) return { kind: 'REJECTED', category: 'PROVIDER_REJECTED', retryable: false, detail: 'no Page is connected' };

      const campaign = await ensure('campaigns', named(p.tag, 'campaign'), {
        objective: 'OUTCOME_TRAFFIC',
        status: 'PAUSED',
        special_ad_categories: [],
        is_adset_budget_sharing_enabled: false,
      });
      if (typeof campaign !== 'string' || !campaign) return failed(campaign as MetaResult);

      const adset = await ensure('adsets', named(p.tag, 'adset'), {
        campaign_id: campaign,
        daily_budget: String(p.dailyBudgetCents),
        billing_event: 'IMPRESSIONS',
        optimization_goal: 'LINK_CLICKS',
        bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
        targeting: {
          geo_locations: { countries: p.countries },
          age_min: 18,
          targeting_automation: { advantage_audience: 1 },
        },
        end_time: p.endTime,
        status: 'PAUSED',
      });
      if (typeof adset !== 'string' || !adset) return failed(adset as MetaResult);

      const creative = await ensure('adcreatives', named(p.tag, 'creative'), {
        object_story_spec: {
          page_id: page,
          link_data: {
            link: p.link,
            message: p.message,
            name: p.headline,
            ...(p.imageUrl ? { picture: p.imageUrl } : {}),
            call_to_action: { type: 'SHOP_NOW', value: { link: p.link } },
          },
        },
      });
      if (typeof creative !== 'string' || !creative) return failed(creative as MetaResult);

      const ad = await ensure('ads', named(p.tag, 'ad'), {
        adset_id: adset,
        creative: { creative_id: creative },
        status: 'PAUSED',
      });
      if (typeof ad !== 'string' || !ad) return failed(ad as MetaResult);

      // Switched on last, ad first so nothing serves until the whole chain is live.
      for (const id of [ad, adset, campaign]) {
        const on = await meta('POST', id, { status: 'ACTIVE' });
        if (!on.ok) return failed(on);
      }
      return { kind: 'CONFIRMED', receiptRef: campaign, receiptMeta: { adsetId: adset, adId: ad } };
    },
    async reconcile(businessId: string): Promise<ReconcileOutcome> {
      const campaign = await findByName('campaigns', named(businessId, 'campaign'));
      if (campaign === 'UNKNOWN') return { kind: 'INCONCLUSIVE', reason: 'Meta did not answer' };
      if (!campaign) return { kind: 'ABSENT' };
      const read = await meta('GET', campaign, { fields: 'status' });
      if (!read.ok) return { kind: 'INCONCLUSIVE', reason: 'Meta did not answer' };
      // A campaign that exists and was never switched on is a send that
      // stopped halfway: resending resumes it by name and creates nothing twice.
      return read.data?.status === 'ACTIVE' ? { kind: 'FOUND', receiptRef: campaign } : { kind: 'ABSENT' };
    },
    health(): AdapterHealth {
      const reading = adsConfig();
      return reading.configured
        ? { usable: true, reason: 'Meta ads are configured.' }
        : { usable: false, reason: `Meta ads are not usable: missing or malformed ${reading.problems.join(', ')}.` };
    },
  };
}

/** What a campaign has spent so far, in the account's minor units. */
export async function campaignSpendCents(campaignId: string): Promise<number | 'UNKNOWN'> {
  const result = await meta('GET', `${campaignId}/insights`, { fields: 'spend', date_preset: 'maximum' });
  if (!result.ok) return 'UNKNOWN';
  const rows = Array.isArray(result.data?.data) ? result.data.data : [];
  if (rows.length === 0) return 0;
  const spend = Number(rows[0]?.spend);
  return Number.isFinite(spend) ? Math.round(spend * 100) : 'UNKNOWN';
}

/** Stop a campaign. Pausing twice is a no-op at Meta, so this is safe to repeat. */
export async function pauseCampaign(campaignId: string): Promise<boolean> {
  const result = await meta('POST', campaignId, { status: 'PAUSED' });
  return result.ok;
}

/** Does the token reach the ad account, and in which currency does it bill? */
export async function probeMeta(): Promise<{ verdict: 'OK' | 'REFUSED' | 'UNKNOWN'; detail: string; currency: string | null }> {
  if (!adsConfig().configured) return { verdict: 'REFUSED', detail: 'not configured', currency: null };
  const result = await meta('GET', adAccountId()!, { fields: 'currency,account_status' });
  if (!result.ok) return { verdict: result.unknown ? 'UNKNOWN' : 'REFUSED', detail: result.detail, currency: null };
  return {
    verdict: Number(result.data?.account_status) === 1 ? 'OK' : 'REFUSED',
    detail: Number(result.data?.account_status) === 1 ? 'the ad account is active' : 'the ad account is not active',
    currency: typeof result.data?.currency === 'string' ? result.data.currency : null,
  };
}
