/**
 * COM-13-3 repair, episode 1: the probe found "no outreach outcome rows"
 * because Brain's real outreach — its Instantly campaigns — never became a
 * `cash_outcomes` row. These tests drive `recordCampaignOutcomes` against a
 * fake Instantly workspace and check that each lead's terminal answer becomes
 * exactly one CONTACT_RESULT, that nothing is guessed, and that the funnel and
 * the probe then model those rows without ever counting a message as a buyer.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import {
  CAMPAIGN_CHANNEL,
  CAMPAIGN_OUTCOMES_CONTINUE_MS,
  CAMPAIGN_OUTCOMES_EVERY_MS,
  CAMPAIGN_OUTCOMES_REQUEST_BUDGET,
  contactResultOf,
  recordCampaignOutcomes,
  resetCampaignOutcomePacing,
  type CampaignLead,
} from '../server/services/cash/journey/campaignOutcomes.ts';
import { CAMPAIGN_NAME, type Deps } from '../server/services/cash/neighborCard.ts';
import { BRAIN_CAMPAIGN_NAME, BRAIN_CAMPAIGN_PREFIX } from '../server/services/cash/providers/instantly.ts';
import { mechanismsFromRows, modelOutreachFunnel } from '../server/services/cash/funnel.ts';

type Lead = { id: string; email: string; status: number; email_reply_count?: number; lt_interest_status?: number };

const NEIGHBOR = 'cmp-neighbor';
const DEAL = 'cmp-deal';
const OTHER = 'cmp-owner-other';

function workspace(leads: Record<string, Lead[]>): { deps: Deps; calls: string[] } {
  const calls: string[] = [];
  const campaigns = [
    { id: NEIGHBOR, name: CAMPAIGN_NAME },
    { id: DEAL, name: BRAIN_CAMPAIGN_NAME },
    { id: OTHER, name: 'Owner mailer · not Brain' },
  ];
  const fetchFake = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    calls.push(`${init?.method ?? 'GET'} ${href}`);
    let body: unknown = { items: [] };
    if (href.includes('/campaigns?')) body = { items: campaigns };
    else if (href.endsWith('/leads/list')) {
      const asked = JSON.parse(String(init?.body ?? '{}')) as { campaign: string };
      body = { items: leads[asked.campaign] ?? [] };
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return {
    calls,
    deps: {
      fetch: fetchFake,
      env: { INSTANTLY_API_KEY: 'test-key' },
      sleep: async () => {},
      resolveMx: async () => true,
      log: () => {},
    },
  };
}

const LEADS: Lead[] = [
  { id: 'l-bounced', email: 'a@one.test', status: -1 },
  { id: 'l-replied', email: 'b@two.test', status: 1, email_reply_count: 1 },
  { id: 'l-unsub', email: 'c@three.test', status: -2 },
  { id: 'l-won', email: 'd@four.test', status: 1, email_reply_count: 1, lt_interest_status: 4 },
  { id: 'l-silent', email: 'e@five.test', status: 3, email_reply_count: 0 },
  { id: 'l-active', email: 'f@six.test', status: 1, email_reply_count: 0 },
  { id: 'l-optout', email: 'g@seven.test', status: 1, email_reply_count: 1 },
];

async function results(projectId: string): Promise<Record<string, string>> {
  const rows = await getDb().all<{ opportunity_id: string; value_text: string; mechanism: string; channel: string }>(
    `SELECT opportunity_id, value_text, mechanism, channel FROM cash_outcomes WHERE project_id = ? AND kind = 'CONTACT_RESULT' ORDER BY opportunity_id`,
    [projectId],
  );
  for (const row of rows) {
    expect(row.mechanism).toBe(CAMPAIGN_NAME);
    expect(row.channel).toBe(CAMPAIGN_CHANNEL);
  }
  return Object.fromEntries(rows.map((row) => [row.opportunity_id.replace('instantly-lead:', ''), row.value_text]));
}

async function seedOptOut(): Promise<void> {
  await getDb().run(
    `INSERT INTO sales_replies (id, email_id, business, campaign_id, lead_email, thread_id, received_at, reply_text, intent,
       stage, status, opt_out, escalation, answer, action, action_detail, answer_email_id, recorded_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, ?)`,
    ['srp-1', 'em-1', 'neighbor-card', NEIGHBOR, 'g@seven.test', 'please remove me', 'OPT_OUT', 'closed_lost', 'done',
      JSON.stringify({ reason: 'asked to be removed' }), 'SUPPRESSED', 'block list', '2026-11-15T00:00:00.000Z'],
  );
}

let projectId: string;
beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  resetCampaignOutcomePacing();
});

describe('a lead\'s terminal answer is read from the provider\'s record, never guessed', () => {
  const lead = (over: Partial<CampaignLead>): CampaignLead => ({ id: 'x', email: null, status: 1, replies: 0, interestStatus: null, ...over });
  it('maps each terminal state, and an active sequence to nothing', () => {
    expect(contactResultOf(lead({ status: -1 }))).toBe('CONTACT_UNDELIVERABLE');
    expect(contactResultOf(lead({ interestStatus: 4, replies: 1 }))).toBe('BUYER_ACCEPTED');
    expect(contactResultOf(lead({ interestStatus: -1, replies: 1 }))).toBe('BUYER_DECLINED');
    expect(contactResultOf(lead({ status: -2 }))).toBe('BUYER_DECLINED');
    expect(contactResultOf(lead({ replies: 1 }), true)).toBe('BUYER_DECLINED');
    expect(contactResultOf(lead({ replies: 2 }))).toBe('BUYER_REPLIED');
    expect(contactResultOf(lead({ status: 3 }))).toBe('BUYER_SILENT');
    expect(contactResultOf(lead({ status: 1 }))).toBeNull();
    expect(contactResultOf(lead({ status: 2 }))).toBeNull();
  });
});

describe('recordCampaignOutcomes', () => {
  it('writes one CONTACT_RESULT per answered lead of Brain\'s campaigns, and none for the deal or the owner\'s other campaign', async () => {
    await seedOptOut();
    const { deps, calls } = workspace({ [NEIGHBOR]: LEADS, [DEAL]: [{ id: 'l-deal', email: 'z@deal.test', status: -1 }], [OTHER]: [{ id: 'l-other', email: 'y@o.test', status: -1 }] });
    const report = await recordCampaignOutcomes(projectId, { deps, ownerProjectId: projectId, force: true });
    expect(report.skipped).toBeNull();
    expect(report.campaigns).toBe(1);
    expect(report.leads).toBe(LEADS.length);
    expect(report.recorded).toBe(6);
    expect(report.pending).toBe(1);
    expect(await results(projectId)).toEqual({
      'l-bounced': 'CONTACT_UNDELIVERABLE',
      'l-optout': 'BUYER_DECLINED',
      'l-replied': 'BUYER_REPLIED',
      'l-silent': 'BUYER_SILENT',
      'l-unsub': 'BUYER_DECLINED',
      'l-won': 'BUYER_ACCEPTED',
    });
    // Read-only toward Instantly.
    expect(calls.every((c) => c.startsWith('GET ') || c.endsWith('/leads/list'))).toBe(true);
    expect(calls.some((c) => c.includes(DEAL) || c.includes(OTHER))).toBe(false);
  });

  it('writes nothing twice, and records an active lead only once its sequence ends', async () => {
    const first = workspace({ [NEIGHBOR]: LEADS });
    await recordCampaignOutcomes(projectId, { deps: first.deps, ownerProjectId: projectId, force: true });
    const again = await recordCampaignOutcomes(projectId, { deps: first.deps, ownerProjectId: projectId, force: true });
    expect(again.recorded).toBe(0);
    expect((await results(projectId))['l-active']).toBeUndefined();

    const ended = LEADS.map((l) => (l.id === 'l-active' ? { ...l, status: 3 } : l.id === 'l-replied' ? { ...l, lt_interest_status: 4 } : l));
    const later = await recordCampaignOutcomes(projectId, { deps: workspace({ [NEIGHBOR]: ended }).deps, ownerProjectId: projectId, force: true });
    expect(later.recorded).toBe(1);
    const now = await results(projectId);
    expect(now['l-active']).toBe('BUYER_SILENT');
    // The first terminal answer stands, as learning.ts treats a deal's contact.
    expect(now['l-replied']).toBe('BUYER_REPLIED');
  });

  it('paces itself: a second pass inside the window reads nothing', async () => {
    const { deps, calls } = workspace({ [NEIGHBOR]: LEADS });
    await recordCampaignOutcomes(projectId, { deps, ownerProjectId: projectId, now: new Date('2026-11-16T00:00:00Z') });
    const n = calls.length;
    const second = await recordCampaignOutcomes(projectId, { deps, ownerProjectId: projectId, now: new Date('2026-11-16T01:00:00Z') });
    expect(second.skipped).toMatch(/read recently/);
    expect(calls.length).toBe(n);
  });

  it('with no Instantly key, writes nothing and says why', async () => {
    const { deps, calls } = workspace({ [NEIGHBOR]: LEADS });
    const report = await recordCampaignOutcomes(projectId, { deps: { ...deps, env: {} }, ownerProjectId: projectId, force: true });
    expect(report.skipped).toMatch(/INSTANTLY_API_KEY/);
    expect(report.recorded).toBe(0);
    expect(calls).toEqual([]);
    expect(await results(projectId)).toEqual({});
  });

  it('with no project holding authority to contact buyers, writes nothing and says why', async () => {
    const { deps, calls } = workspace({ [NEIGHBOR]: LEADS });
    const report = await recordCampaignOutcomes(projectId, { deps, force: true });
    expect(report.skipped).toMatch(/no cash project holds standing commercial authority/);
    expect(calls).toEqual([]);
    expect(await results(projectId)).toEqual({});
  });

  it('records only on the owning project, so a campaign is never counted twice', async () => {
    const { deps } = workspace({ [NEIGHBOR]: LEADS });
    const report = await recordCampaignOutcomes(projectId, { deps, ownerProjectId: 'prj_someone_else', force: true });
    expect(report.skipped).toMatch(/recorded on project prj_someone_else/);
    expect(await results(projectId)).toEqual({});
  });

  it('a failed read writes nothing for that campaign and is reported', async () => {
    const { deps } = workspace({ [NEIGHBOR]: LEADS });
    const failing: Deps = {
      ...deps,
      fetch: (async (url: string | URL | Request, init?: RequestInit) =>
        String(url).endsWith('/leads/list') ? new Response('nope', { status: 403 }) : deps.fetch(url, init)) as typeof fetch,
    };
    const report = await recordCampaignOutcomes(projectId, { deps: failing, ownerProjectId: projectId, force: true });
    expect(report.failed).toHaveLength(1);
    expect(report.recorded).toBe(0);
    expect(await results(projectId)).toEqual({});
  });
});

describe('the funnel models the recorded campaign, and messages are not buyers', () => {
  it('yields one mechanism named by the campaign, measured from its rows', async () => {
    await seedOptOut();
    await recordCampaignOutcomes(projectId, { deps: workspace({ [NEIGHBOR]: LEADS }).deps, ownerProjectId: projectId, force: true });
    const mechanisms = await mechanismsFromRows(projectId, { permission: { basis: 'MEASURED', value: 1 } });
    expect(mechanisms.map((m) => m.mode)).toEqual([CAMPAIGN_NAME]);
    const m = mechanisms[0]!;
    expect(m.inputs.uniqueProspects).toEqual({ basis: 'MEASURED', value: 6 });
    expect(m.inputs.deliverability).toEqual({ basis: 'MEASURED', value: 5 / 6 });
    const r = modelOutreachFunnel(m);
    const scaled = modelOutreachFunnel({ ...m, messagesSent: 1_000_000 });
    expect(scaled.buyers).toEqual(r.buyers);
    expect(scaled.revenueCents).toEqual(r.revenueCents);
    expect(scaled.reachedProspects).toEqual(r.reachedProspects);
  });

  it('gives probe r01.com-13-3 a mechanism to model on the rows, and it passes', async () => {
    const { getProbe } = await import('../server/services/factory/program/probes.ts');
    const before = await getProbe('r01.com-13-3')!({});
    expect(before.detail).toMatch(/no outreach outcome rows/);
    await recordCampaignOutcomes(projectId, { deps: workspace({ [NEIGHBOR]: LEADS }).deps, ownerProjectId: projectId, force: true });
    const after = await getProbe('r01.com-13-3')!({});
    expect(after.detail).toMatch(/1 mechanism/);
    expect(after.ok).toBe(true);
  });
});

/**
 * A workspace as large as the old read's own ceilings: 20 pages of campaigns,
 * three of them Brain's, each 50 pages of 100 leads. Every lead has bounced, so
 * each is one row. `refuseAt` answers that request number (1-based) with a 429.
 */
function largeWorkspace(opts: { refuseAt?: number } = {}): { deps: Deps; calls: string[]; slept: number[] } {
  const calls: string[] = [];
  const slept: number[] = [];
  const brain = [`${NEIGHBOR}-a`, `${NEIGHBOR}-b`, `${NEIGHBOR}-c`];
  const fetchFake = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    calls.push(`${init?.method ?? 'GET'} ${href}`);
    if (opts.refuseAt === calls.length) return new Response('Too Many Requests', { status: 429 });
    let body: Record<string, unknown> = { items: [] };
    if (href.includes('/campaigns?')) {
      const after = new URL(href).searchParams.get('starting_after');
      const page = after ? Number(after.replace('cp', '')) : 0;
      const items = Array.from({ length: 100 }, (_, i) => ({ id: `owner-${page}-${i}`, name: `Owner mailer ${page}-${i}` }));
      if (page === 0) items.splice(0, 3, ...brain.map((id) => ({ id, name: `${BRAIN_CAMPAIGN_PREFIX}${id}` })));
      body = { items, ...(page < 19 ? { next_starting_after: `cp${page + 1}` } : {}) };
    } else if (href.endsWith('/leads/list')) {
      const asked = JSON.parse(String(init?.body ?? '{}')) as { campaign: string; starting_after?: string };
      const page = asked.starting_after ? Number(asked.starting_after.split(':')[1]) : 0;
      const items = Array.from({ length: 100 }, (_, i) => ({ id: `${asked.campaign}-${page}-${i}`, email: `${page}-${i}@${asked.campaign}.test`, status: -1 }));
      body = { items, ...(page < 49 ? { next_starting_after: `${asked.campaign}:${page + 1}` } : {}) };
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return {
    calls,
    slept,
    deps: {
      fetch: fetchFake,
      env: { INSTANTLY_API_KEY: 'test-key' },
      sleep: async (ms: number) => {
        slept.push(ms);
      },
      resolveMx: async () => true,
      log: () => {},
    },
  };
}

async function rowCount(): Promise<number> {
  const row = await getDb().get<{ n: number }>(`SELECT COUNT(*) AS n FROM cash_outcomes WHERE project_id = ? AND kind = 'CONTACT_RESULT'`, [projectId]);
  return Number(row?.n ?? 0);
}

describe('one pass spends a bounded share of the workspace\'s 20 requests a minute, and never waits inside the tick', () => {
  it('a workspace at the old ceilings is read across passes, each within the budget, with no request repeated', async () => {
    expect(CAMPAIGN_OUTCOMES_REQUEST_BUDGET).toBeLessThan(20);
    const { deps, calls, slept } = largeWorkspace();
    const start = Date.parse('2026-11-16T00:00:00Z');

    const first = await recordCampaignOutcomes(projectId, { deps, ownerProjectId: projectId, now: new Date(start) });
    // The old read issued all 20 campaign pages and 150 lead pages here, in one pass.
    expect(calls.length).toBe(CAMPAIGN_OUTCOMES_REQUEST_BUDGET);
    expect(first.requests).toBe(CAMPAIGN_OUTCOMES_REQUEST_BUDGET);
    expect(first.stoppedEarly).toMatch(/budget/);
    // Inside the continue window nothing is read; after it, the read continues.
    const early = await recordCampaignOutcomes(projectId, { deps, ownerProjectId: projectId, now: new Date(start + CAMPAIGN_OUTCOMES_CONTINUE_MS - 1) });
    expect(early.skipped).toMatch(/read recently/);
    expect(calls.length).toBe(CAMPAIGN_OUTCOMES_REQUEST_BUDGET);

    let at = start;
    let passes = 1;
    let last = first;
    while (last.stoppedEarly && passes < 100) {
      at += CAMPAIGN_OUTCOMES_CONTINUE_MS;
      const before = calls.length;
      last = await recordCampaignOutcomes(projectId, { deps, ownerProjectId: projectId, now: new Date(at) });
      expect(calls.length - before).toBeLessThanOrEqual(CAMPAIGN_OUTCOMES_REQUEST_BUDGET);
      expect(last.requests).toBe(calls.length - before);
      passes += 1;
    }
    expect(last.stoppedEarly).toBeNull();
    // Every page read exactly once across the passes: 20 campaign pages, 3 x 50 lead pages.
    expect(calls.length).toBe(20 + 3 * 50);
    expect(new Set(calls.map((c, i) => (c.endsWith('/leads/list') ? `lead#${i}` : c))).size).toBe(calls.length);
    expect(passes).toBe(Math.ceil(calls.length / CAMPAIGN_OUTCOMES_REQUEST_BUDGET));
    expect(await rowCount()).toBe(3 * 50 * 100);
    expect(slept).toEqual([]);

    // A finished read waits the full pacing before starting over.
    const soon = await recordCampaignOutcomes(projectId, { deps, ownerProjectId: projectId, now: new Date(at + CAMPAIGN_OUTCOMES_CONTINUE_MS) });
    expect(soon.skipped).toMatch(/read recently/);
    const later = await recordCampaignOutcomes(projectId, { deps, ownerProjectId: projectId, now: new Date(at + CAMPAIGN_OUTCOMES_EVERY_MS) });
    expect(later.requests).toBe(CAMPAIGN_OUTCOMES_REQUEST_BUDGET);
    expect(later.recorded).toBe(0);
  });

  it('a 429 ends the pass at once instead of waiting out the window, keeps what it read, and the next pass continues from that page', async () => {
    // Request 3 is the third page of the campaign listing.
    const { deps, calls, slept } = largeWorkspace({ refuseAt: 3 });
    const start = Date.parse('2026-11-16T00:00:00Z');
    const first = await recordCampaignOutcomes(projectId, { deps, ownerProjectId: projectId, now: new Date(start), requestBudget: 30 });
    expect(slept).toEqual([]);
    expect(calls.length).toBe(3);
    expect(first.stoppedEarly).toMatch(/refused/);
    expect(first.failed).toEqual([]);

    // The listing resumes at the refused page; nothing already read is asked again.
    const second = await recordCampaignOutcomes(projectId, { deps, ownerProjectId: projectId, now: new Date(start + CAMPAIGN_OUTCOMES_CONTINUE_MS), requestBudget: 30 });
    expect(calls[3]).toBe(calls[2]);
    expect(calls.slice(0, 3).filter((c) => c === calls[1])).toHaveLength(1);
    expect(second.requests).toBe(30);
    // 18 remaining list pages, then 12 lead pages of the first campaign, recorded as they arrived.
    expect(await rowCount()).toBe(12 * 100);
    expect(slept).toEqual([]);
  });

  it('a 429 on a lead page keeps the rows of the pages before it, and the next pass reads the refused page, not the first', async () => {
    const { deps, calls, slept } = largeWorkspace({ refuseAt: 23 });
    const start = Date.parse('2026-11-16T00:00:00Z');
    const first = await recordCampaignOutcomes(projectId, { deps, ownerProjectId: projectId, now: new Date(start), requestBudget: 40 });
    expect(slept).toEqual([]);
    expect(first.stoppedEarly).toMatch(/refused/);
    // 20 list pages, 2 lead pages recorded, the third refused.
    expect(calls.length).toBe(23);
    expect(await rowCount()).toBe(200);
    await recordCampaignOutcomes(projectId, { deps, ownerProjectId: projectId, now: new Date(start + CAMPAIGN_OUTCOMES_CONTINUE_MS), requestBudget: 1 });
    expect(calls.length).toBe(24);
    expect(calls[23]).toBe(calls[22]);
    expect(await rowCount()).toBe(300);
  });
});
