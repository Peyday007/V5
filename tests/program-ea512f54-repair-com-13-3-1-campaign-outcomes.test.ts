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
  CAMPAIGN_OUTCOMES_REQUESTS_PER_PASS,
  contactResultOf,
  recordCampaignOutcomes,
  resetCampaignOutcomePacing,
  type CampaignLead,
} from '../server/services/cash/journey/campaignOutcomes.ts';
import { CAMPAIGN_NAME, type Deps } from '../server/services/cash/neighborCard.ts';
import { BRAIN_CAMPAIGN_NAME } from '../server/services/cash/providers/instantly.ts';
import { mechanismsFromRows, modelOutreachFunnel } from '../server/services/cash/funnel.ts';

type Lead = { id: string; email: string; status: number; email_reply_count?: number; lt_interest_status?: number; timestamp_created?: string };

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

// Six leads enrolled on 1 November, every one terminal; one enrolled on 10 November, still in its sequence.
const NOV1 = '2026-11-01T09:00:00.000Z';
const NOV10 = '2026-11-10T09:00:00.000Z';
const LEADS: Lead[] = [
  { id: 'l-bounced', email: 'a@one.test', status: -1, timestamp_created: NOV1 },
  { id: 'l-replied', email: 'b@two.test', status: 1, email_reply_count: 1, timestamp_created: NOV1 },
  { id: 'l-unsub', email: 'c@three.test', status: -2, timestamp_created: NOV1 },
  { id: 'l-won', email: 'd@four.test', status: 1, email_reply_count: 1, lt_interest_status: 4, timestamp_created: NOV1 },
  { id: 'l-silent', email: 'e@five.test', status: 3, email_reply_count: 0, timestamp_created: NOV1 },
  { id: 'l-active', email: 'f@six.test', status: 1, email_reply_count: 0, timestamp_created: NOV10 },
  { id: 'l-optout', email: 'g@seven.test', status: 1, email_reply_count: 1, timestamp_created: NOV1 },
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
  const lead = (over: Partial<CampaignLead>): CampaignLead => ({ id: 'x', email: null, status: 1, replies: 0, interestStatus: null, enrolledAt: null, ...over });
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
    expect(report.held).toBe(0);
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

describe('answers are recorded by enrolment cohort, so a running campaign never overstates its rates', () => {
  // One cohort of ten, enrolled the same day: two replied and one bounced early (their sequences ended),
  // one finished silent, and six are still being sent their follow-ups.
  const DAY = '2026-11-12T08:00:00.000Z';
  const cohort = (active: boolean): Lead[] => [
    { id: 'c-r1', email: 'r1@x.test', status: 3, email_reply_count: 1, timestamp_created: DAY },
    { id: 'c-r2', email: 'r2@x.test', status: 3, email_reply_count: 1, timestamp_created: DAY },
    { id: 'c-b1', email: 'b1@x.test', status: -1, timestamp_created: DAY },
    { id: 'c-s1', email: 's1@x.test', status: 3, timestamp_created: DAY },
    ...Array.from({ length: 6 }, (_, i): Lead => ({ id: `c-q${i}`, email: `q${i}@x.test`, status: active ? 1 : 3, timestamp_created: DAY })),
  ];

  it('records none of a cohort while any of its leads is still in its sequence', async () => {
    const report = await recordCampaignOutcomes(projectId, { deps: workspace({ [NEIGHBOR]: cohort(true) }).deps, ownerProjectId: projectId, force: true });
    expect(report.recorded).toBe(0);
    expect(report.pending).toBe(6);
    expect(report.held).toBe(4);
    expect(await results(projectId)).toEqual({});
    // Recorded lead by lead this would read 2 of 3 delivered leads as answering; the cohort waits instead.
    expect(await mechanismsFromRows(projectId, { permission: { basis: 'MEASURED', value: 1 } })).toEqual([]);
  });

  it('once the cohort has ended, the funnel reads every lead it enrolled, at the true rates', async () => {
    await recordCampaignOutcomes(projectId, { deps: workspace({ [NEIGHBOR]: cohort(true) }).deps, ownerProjectId: projectId, force: true });
    const ended = await recordCampaignOutcomes(projectId, { deps: workspace({ [NEIGHBOR]: cohort(false) }).deps, ownerProjectId: projectId, force: true });
    expect(ended.recorded).toBe(10);
    expect(ended.held).toBe(0);
    const [m] = await mechanismsFromRows(projectId, { permission: { basis: 'MEASURED', value: 1 } });
    expect(m!.inputs.uniqueProspects).toEqual({ basis: 'MEASURED', value: 10 });
    expect(m!.inputs.deliverability).toEqual({ basis: 'MEASURED', value: 9 / 10 });
    expect(m!.inputs.response).toEqual({ basis: 'MEASURED', value: 2 / 9 });
  });

  it('a cohort still sending holds back only itself, never an earlier one that has ended', async () => {
    const leads: Lead[] = [
      { id: 'e-r', email: 'er@x.test', status: 3, email_reply_count: 1, timestamp_created: NOV1 },
      { id: 'e-s', email: 'es@x.test', status: 3, timestamp_created: NOV1 },
      { id: 'n-r', email: 'nr@x.test', status: 3, email_reply_count: 1, timestamp_created: NOV10 },
      { id: 'n-a', email: 'na@x.test', status: 2, timestamp_created: NOV10 },
    ];
    const report = await recordCampaignOutcomes(projectId, { deps: workspace({ [NEIGHBOR]: leads }).deps, ownerProjectId: projectId, force: true });
    expect(report).toMatchObject({ recorded: 2, pending: 1, held: 1 });
    expect(await results(projectId)).toEqual({ 'e-r': 'BUYER_REPLIED', 'e-s': 'BUYER_SILENT' });
  });

  it('leads with no enrolment time are one cohort, and a skipped lead is never sent to, so it records nothing and holds nothing', async () => {
    const leads: Lead[] = [
      { id: 'u-r', email: 'ur@x.test', status: 3, email_reply_count: 1 },
      { id: 'u-a', email: 'ua@x.test', status: 1 },
      { id: 'k-r', email: 'kr@x.test', status: 3, email_reply_count: 1, timestamp_created: NOV1 },
      { id: 'k-skip', email: 'ks@x.test', status: -3, timestamp_created: NOV1 },
    ];
    const report = await recordCampaignOutcomes(projectId, { deps: workspace({ [NEIGHBOR]: leads }).deps, ownerProjectId: projectId, force: true });
    expect(report).toMatchObject({ recorded: 1, pending: 1, held: 1 });
    expect(await results(projectId)).toEqual({ 'k-r': 'BUYER_REPLIED' });
  });
});

/*
 * Reviewer finding (repair-rate-budget-unbounded): one pass could send up to
 * 20 campaign-list pages plus 50 lead pages per campaign against a workspace
 * limited to 20 requests a minute, and `instantly()` backs a 429 off by
 * sleeping — inside `advanceJourney`, ahead of the deal passes. A pass now
 * sends at most CAMPAIGN_OUTCOMES_REQUESTS_PER_PASS requests, never sleeps,
 * and the next pass continues the read where it stopped.
 */
describe('one pass is bounded by a request budget and never waits inside the tick', () => {
  const PAGE = 100;
  /** A paged workspace: `campaignCount` Brain campaigns over pages of 2, each with `leadPages` pages of leads. */
  function pagedWorkspace(campaignCount: number, leadPages: number, options: { throttleAt?: number } = {}) {
    const calls: string[] = [];
    const sleeps: number[] = [];
    const campaigns = Array.from({ length: campaignCount }, (_, i) => ({ id: `cmp-${i}`, name: `${CAMPAIGN_NAME} ${String(i).padStart(2, '0')}` }));
    // Brain's own campaigns are matched by the sales desk's lead rows here, as production matches them.
    const leadsOf = (campaign: string, page: number) =>
      Array.from({ length: PAGE }, (_, j) => ({ id: `${campaign}-p${page}-${j}`, email: `${campaign}-${page}-${j}@x.test`, status: 3, timestamp_created: NOV1 }));
    const fetchFake = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      calls.push(`${init?.method ?? 'GET'} ${href}`);
      if (options.throttleAt !== undefined && calls.length === options.throttleAt) return new Response('slow down', { status: 429 });
      let body: Record<string, unknown> = { items: [] };
      if (href.includes('/campaigns?')) {
        const after = new URL(href).searchParams.get('starting_after');
        const start = after ? Number(after) : 0;
        const next = start + 2 < campaigns.length ? String(start + 2) : undefined;
        body = { items: campaigns.slice(start, start + 2), ...(next ? { next_starting_after: next } : {}) };
      } else if (href.endsWith('/leads/list')) {
        const asked = JSON.parse(String(init?.body ?? '{}')) as { campaign: string; starting_after?: string };
        const page = asked.starting_after ? Number(asked.starting_after) : 0;
        body = { items: leadsOf(asked.campaign, page), ...(page + 1 < leadPages ? { next_starting_after: String(page + 1) } : {}) };
      }
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const deps: Deps = {
      fetch: fetchFake,
      env: { INSTANTLY_API_KEY: 'test-key' },
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      resolveMx: async () => true,
      log: () => {},
    };
    return { deps, calls, sleeps, campaigns };
  }

  async function seedDeskCampaigns(ids: string[]): Promise<void> {
    for (const id of ids) {
      await getDb().run(
        `INSERT INTO sales_leads (id, business, email, domain, campaign_id, variant, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [`sl-${id}`, 'neighbor-card', `${id}@desk.test`, 'desk.test', id, 'TEMPLATE', NOV1, NOV1],
      );
    }
  }

  async function countRows(): Promise<number> {
    const row = await getDb().get<{ n: number }>(`SELECT COUNT(*) AS n FROM cash_outcomes WHERE project_id = ? AND kind = 'CONTACT_RESULT'`, [projectId]);
    return Number(row?.n ?? 0);
  }

  it('a large workspace is read over several passes, each within the budget, with no sleep, and recorded whole', async () => {
    const ws = pagedWorkspace(9, 3);
    await seedDeskCampaigns(ws.campaigns.map((c) => c.id));
    // Every campaign-list page and every lead page the unbounded read would have sent.
    const needed = Math.ceil(9 / 2) + 9 * 3;
    expect(needed).toBeGreaterThan(CAMPAIGN_OUTCOMES_REQUESTS_PER_PASS * 3);

    let at = Date.parse('2026-11-16T00:00:00Z');
    let passes = 0;
    let recorded = 0;
    for (;;) {
      const before = ws.calls.length;
      const report = await recordCampaignOutcomes(projectId, { deps: ws.deps, ownerProjectId: projectId, now: new Date(at) });
      passes += 1;
      const sent = ws.calls.length - before;
      expect(report.requests).toBe(sent);
      expect(sent).toBeLessThanOrEqual(CAMPAIGN_OUTCOMES_REQUESTS_PER_PASS);
      recorded += report.recorded;
      if (!report.paused) break;
      expect(report.paused).toMatch(/budget/);
      expect(passes).toBeLessThan(20);
      at += CAMPAIGN_OUTCOMES_CONTINUE_MS;
    }
    expect(ws.sleeps).toEqual([]);
    expect(passes).toBe(Math.ceil(needed / CAMPAIGN_OUTCOMES_REQUESTS_PER_PASS));
    // Every page was read exactly once across the passes, and every lead recorded once.
    expect(ws.calls.length).toBe(needed);
    expect(new Set(ws.calls.filter((c) => c.includes('/campaigns?'))).size).toBe(Math.ceil(9 / 2));
    expect(recorded).toBe(9 * 3 * PAGE);
    expect(await countRows()).toBe(9 * 3 * PAGE);

    // The read is finished: the next pass inside the window sends nothing.
    const quiet = await recordCampaignOutcomes(projectId, { deps: ws.deps, ownerProjectId: projectId, now: new Date(at + CAMPAIGN_OUTCOMES_CONTINUE_MS) });
    expect(quiet.skipped).toMatch(/read recently/);
    expect(quiet.requests).toBe(0);
  });

  it('a campaign read only partly by one pass records nothing of it until its last page is read', async () => {
    const ws = pagedWorkspace(1, 12);
    await seedDeskCampaigns(ws.campaigns.map((c) => c.id));
    const first = await recordCampaignOutcomes(projectId, { deps: ws.deps, ownerProjectId: projectId, force: true });
    expect(first.paused).toMatch(/budget/);
    expect(first.recorded).toBe(0);
    expect(await countRows()).toBe(0);
    const second = await recordCampaignOutcomes(projectId, { deps: ws.deps, ownerProjectId: projectId, force: true });
    expect(second.paused).toBeNull();
    expect(second.recorded).toBe(12 * PAGE);
    expect(ws.sleeps).toEqual([]);
  });

  it('an unfinished read waits out the rate window rather than resending inside it', async () => {
    const ws = pagedWorkspace(1, 12);
    await seedDeskCampaigns(ws.campaigns.map((c) => c.id));
    const t0 = Date.parse('2026-11-16T00:00:00Z');
    await recordCampaignOutcomes(projectId, { deps: ws.deps, ownerProjectId: projectId, now: new Date(t0) });
    const n = ws.calls.length;
    const soon = await recordCampaignOutcomes(projectId, { deps: ws.deps, ownerProjectId: projectId, now: new Date(t0 + 10_000) });
    expect(soon.skipped).toMatch(/rate window/);
    expect(ws.calls.length).toBe(n);
    const later = await recordCampaignOutcomes(projectId, { deps: ws.deps, ownerProjectId: projectId, now: new Date(t0 + CAMPAIGN_OUTCOMES_CONTINUE_MS) });
    expect(later.requests).toBeGreaterThan(0);
  });

  it('a 429 ends the pass at once instead of backing off, and the next pass continues where it stopped', async () => {
    const ws = pagedWorkspace(2, 2, { throttleAt: 3 });
    await seedDeskCampaigns(ws.campaigns.map((c) => c.id));
    const first = await recordCampaignOutcomes(projectId, { deps: ws.deps, ownerProjectId: projectId, force: true });
    expect(ws.sleeps).toEqual([]);
    expect(first.requests).toBe(3);
    expect(first.paused).toMatch(/slow down/);
    expect(first.failed).toEqual([]);
    expect(first.recorded).toBe(0);
    const second = await recordCampaignOutcomes(projectId, { deps: ws.deps, ownerProjectId: projectId, force: true });
    expect(second.paused).toBeNull();
    expect(await countRows()).toBe(2 * 2 * PAGE);
    expect(ws.sleeps).toEqual([]);
  });
});
