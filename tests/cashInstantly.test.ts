/**
 * The owner's Instantly workspace as Brain's buyer-outreach provider (§94),
 * against a fake Instantly API v2 shaped like the owner's real workspace read
 * on 2026-11-09 (healthy and broken sending accounts, the owner's own active
 * campaign that Brain must never touch).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { capture } from '../server/services/cash/opportunities.ts';
import { transitionOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordAction } from '../server/repos/cashActions.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import { observationsFor } from '../server/repos/cashJourney.ts';
import { clearAdapters, registerAdapter } from '../server/services/effects/adapter.ts';
import { CONTACT_BUYER_NAMESPACE, sendContactBuyer } from '../server/services/cash/effects.ts';
import { performCommercialAction } from '../server/services/cash/perform.ts';
import { messagingConfig } from '../server/services/cash/providers/config.ts';
import { registerCommercialProviders } from '../server/services/cash/providers/register.ts';
import {
  BRAIN_CAMPAIGN_NAME,
  createInstantlyAdapter,
  forgetInstantlyCapacity,
  instantlyCapacity,
  prepareInstantlyLeads,
  probeInstantly,
  readInstantlyWorkspace,
} from '../server/services/cash/providers/instantly.ts';
import { syncInstantlyReplies } from '../server/services/cash/providers/instantlySync.ts';
import { evaluateGoalPortfolio } from '../server/services/goals/portfolio.ts';
import type { FetchLike } from '../server/services/cash/providers/http.ts';

const KEY = 'instantly_test_SECRETVALUE_never_stored_0003';
const ENV = { BRAIN_MESSAGING_PROVIDER: 'instantly', INSTANTLY_API_KEY: KEY } as NodeJS.ProcessEnv;
const OWNERS = '1d3cf504-fa08-403b-aa5c-b50d44958f0c';

interface Call { method: string; path: string; headers: Record<string, string>; body: Record<string, unknown> }

function fakeInstantly(options: { brainCampaign?: { id: string; status: number } | null; leadStatus?: number; replies?: Record<string, unknown>[] } = {}) {
  const calls: Call[] = [];
  let brain = options.brainCampaign ?? null;
  const fetchImpl: FetchLike = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname.replace('/api/v2', '') + u.search;
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ method: String(init.method), path, headers: init.headers as Record<string, string>, body });
    const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status });
    if (path.startsWith('/accounts')) {
      return json(200, {
        items: [
          { email: 'a@ventureprodigy.example', status: 1, warmup_status: 1, daily_limit: 90 },
          { email: 'b@aligninspiration.example', status: 1, warmup_status: 1, daily_limit: 90 },
          { email: 'c@cleanflow.example', status: 1, warmup_status: -1, daily_limit: 15 },
          { email: 'd@windycity.example', status: -1, warmup_status: -1, daily_limit: 15 },
        ],
      });
    }
    if (path.startsWith('/campaigns') && init.method === 'GET') {
      return json(200, { items: [{ id: OWNERS, name: 'AI Dispatch', status: 1 }, ...(brain ? [{ id: brain.id, name: BRAIN_CAMPAIGN_NAME, status: brain.status }] : [])] });
    }
    if (path === '/campaigns' && init.method === 'POST') {
      brain = { id: '11111111-2222-3333-4444-555555555555', status: 0 };
      return json(200, { id: brain.id, status: 0, name: body.name });
    }
    if (/^\/campaigns\/[^/]+\/activate$/.test(path)) {
      if (brain) brain.status = 1;
      return json(200, { id: brain?.id, status: 1 });
    }
    if (path === '/leads' && init.method === 'POST') {
      if (options.leadStatus === 500) return new Response('down', { status: 500 });
      return json(200, { id: `lead_${calls.length}`, email: body.email });
    }
    if (path.startsWith('/lead-lists') && init.method === 'GET') return json(200, { items: [] });
    if (path === '/lead-lists' && init.method === 'POST') return json(200, { id: 'list_1', name: body.name });
    if (path.startsWith('/emails')) return json(200, { items: options.replies ?? [] });
    return json(404, { error: 'not found' });
  };
  return { calls, fetchImpl, brain: () => brain };
}

let projectId = '';
let userId = '';

beforeEach(async () => {
  clearAdapters();
  forgetInstantlyCapacity();
  const fixture = await freshProject();
  projectId = fixture.project.id;
  userId = (await createUser({ email: `instantly-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash over the next few weeks.' })).ok).toBe(true);
});

function contactRequest() {
  return {
    occurrence: '1',
    authorityId: 'cau_fixed',
    stateAtSend: 'READY',
    projectId,
    opportunityId: 'cop_fixed',
    payer: 'Northwind Marketing',
    channel: 'owner@northwind.example',
    message: { to: 'owner@northwind.example', subject: 'White-label articles for your clients', text: '$90 per article; a prepaid pack of 10 is $900.' },
  };
}

describe('configuration', () => {
  it('needs the workspace key and no sender address, and names settings, never values', () => {
    expect(messagingConfig(ENV)).toMatchObject({ provider: 'instantly', configured: true });
    const missing = messagingConfig({ BRAIN_MESSAGING_PROVIDER: 'instantly' } as NodeJS.ProcessEnv);
    expect(missing.configured).toBe(false);
    expect(missing.problems).toEqual(['INSTANTLY_API_KEY']);
    expect(messagingConfig({ ...ENV, BRAIN_INSTANTLY_CAMPAIGN_ID: 'nope' }).problems[0]).toMatch(/BRAIN_INSTANTLY_CAMPAIGN_ID/);
  });

  it('registers the Instantly adapter for CONTACT_BUYER when the deployment selects it', () => {
    expect(registerCommercialProviders(ENV).messaging).toBe('instantly');
  });
});

describe('reading the workspace sends nothing', () => {
  it('counts only healthy sending accounts toward the daily capacity, and makes only GETs', async () => {
    const fake = fakeInstantly();
    const read = await readInstantlyWorkspace({ fetch: fake.fetchImpl, env: ENV });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.workspace.healthyAccounts).toHaveLength(2);
    expect(read.workspace.dailyCapacity).toBe(180);
    expect(fake.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(fake.calls[0]!.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(fake.calls.every((c) => !c.path.includes(KEY))).toBe(true);
    const probe = await probeInstantly({ fetch: fake.fetchImpl, env: ENV });
    expect(probe.verdict).toBe('VERIFIED');
    expect(probe.detail).toMatch(/2 of 4 sending accounts healthy, 180 a day/);
    expect(fake.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('prepares leads into a lead list, never a campaign, skipping anyone the workspace already holds', async () => {
    const fake = fakeInstantly();
    const out = await prepareInstantlyLeads({ listName: 'Brain · agencies', leads: [{ email: 'owner@northwind.example', companyName: 'Northwind' }], fetch: fake.fetchImpl, env: ENV });
    expect(out).toMatchObject({ ok: true, listId: 'list_1', added: 1 });
    const lead = fake.calls.find((c) => c.path === '/leads')!;
    expect(lead.body.list_id).toBe('list_1');
    expect(lead.body.campaign).toBeUndefined();
    expect(lead.body.skip_if_in_workspace).toBe(true);
    expect(fake.calls.some((c) => c.path.includes('/activate'))).toBe(false);
  });

  it('feeds the measured capacity to the quant engine as the top of the swept range, never as Brain\'s own figure', async () => {
    const fake = fakeInstantly();
    const capacity = await instantlyCapacity({ fetch: fake.fetchImpl, env: ENV });
    expect(capacity).toEqual({ perDay: 180, accounts: 2 });
    const portfolio = evaluateGoalPortfolio({ openings: [], remaining: 10_000, daysLeft: 18, capitalCeiling: 3000, beforeProof: 375, perWeek: 750, resources: null, measuredCapacity: capacity, worlds: 10 });
    expect(portfolio.limits.contactsPerDay.value).toBeNull();
    expect(portfolio.limits.contactsPerDay.high).toBe(180);
    expect(portfolio.limits.contactsPerDay.source).toMatch(/measured: up to 180\/day on 2 healthy Instantly accounts \(shared\)/);
    // Not Instantly: no request at all.
    expect(await instantlyCapacity({ fetch: fake.fetchImpl, env: {} as NodeJS.ProcessEnv })).toBeNull();
  });
});

describe('CONTACT_BUYER through Instantly', () => {
  it('drafts Brain\'s own campaign, adds exactly one lead with this offer, activates only Brain\'s campaign, and never touches the owner\'s', async () => {
    const fake = fakeInstantly();
    registerAdapter(createInstantlyAdapter({ fetch: fake.fetchImpl, env: ENV, namespace: CONTACT_BUYER_NAMESPACE.name }));
    const outcome = await sendContactBuyer(contactRequest());
    expect(outcome.status).toBe('CONFIRMED');
    const created = fake.calls.find((c) => c.path === '/campaigns' && c.method === 'POST')!;
    expect(created.body.name).toBe(BRAIN_CAMPAIGN_NAME);
    expect(created.body.email_list).toEqual(['a@ventureprodigy.example', 'b@aligninspiration.example']);
    expect(JSON.stringify(created.body.sequences)).toContain('{{brain_subject}}');
    expect(created.body.stop_on_reply).toBe(true);
    const lead = fake.calls.find((c) => c.path === '/leads')!;
    expect(lead.body).toMatchObject({ campaign: '11111111-2222-3333-4444-555555555555', email: 'owner@northwind.example', skip_if_in_workspace: true });
    expect((lead.body.custom_variables as Record<string, string>).brain_subject).toBe('White-label articles for your clients');
    const activations = fake.calls.filter((c) => c.path.includes('/activate'));
    expect(activations).toHaveLength(1);
    expect(activations[0]!.path).toContain('11111111-2222-3333-4444-555555555555');
    expect(fake.calls.some((c) => c.path.includes(OWNERS) && c.method === 'POST')).toBe(false);
  });

  it('a lost answer adding the lead is UNCERTAIN and activates nothing', async () => {
    const fake = fakeInstantly({ brainCampaign: { id: '99999999-2222-3333-4444-555555555555', status: 0 }, leadStatus: 500 });
    registerAdapter(createInstantlyAdapter({ fetch: fake.fetchImpl, env: ENV, namespace: CONTACT_BUYER_NAMESPACE.name }));
    const outcome = await sendContactBuyer(contactRequest());
    expect(outcome.status).toBe('UNCERTAIN');
    expect(fake.calls.some((c) => c.path.includes('/activate'))).toBe(false);
  });

  it('without a standing CONTACT_BUYER grant nothing reaches Instantly', async () => {
    const fake = fakeInstantly();
    registerAdapter(createInstantlyAdapter({ fetch: fake.fetchImpl, env: ENV, namespace: CONTACT_BUYER_NAMESPACE.name }));
    const captured = await capture({ projectId, actorRef: userId, ownerUserId: userId, title: 'Agency white-label articles', mechanism: 'OTHER', currency: 'USD' });
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    await transitionOpportunity({ id: captured.value.id, from: ['DISCOVERED'], to: 'READY', outcome: 'test' });
    const result = await performCommercialAction({ opportunityId: captured.value.id, action: 'CONTACT_BUYER', actorRef: 'BRAIN', expectedOccurrence: '1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Not authorized to CONTACT_BUYER/);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('replies feed the quant engine', () => {
  it('a reply on Brain\'s campaign becomes one BUYER_REPLIED observation on the contacted deal; auto-replies and strangers do not', async () => {
    const captured = await capture({ projectId, actorRef: userId, ownerUserId: userId, title: 'Agency white-label articles', mechanism: 'OTHER', currency: 'USD' });
    if (!captured.ok) throw new Error(captured.reason);
    const authority = await createAuthority({ projectId, ownerUserId: userId, createdByUserId: userId, name: 'grant', allowedActions: [...COMMERCIAL_ACTIONS], prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL], maxCommittedCents: 100_000, maxPerActionCents: 40_000, maxConcurrent: 3, currency: 'USD' });
    await recordAction({ projectId, opportunityId: captured.value.id, authorityId: authority.id, action: 'CONTACT_BUYER', performedBy: 'BRAIN', reference: 'lead_42', detail: 'Reached via Instantly', confirmedBy: 'BRAIN', requestKey: `t:${captured.value.id}` });
    const fake = fakeInstantly({
      brainCampaign: { id: '11111111-2222-3333-4444-555555555555', status: 1 },
      replies: [
        { id: 'em_1', lead_id: 'lead_42', lead: 'owner@northwind.example', campaign_id: '11111111-2222-3333-4444-555555555555', ue_type: 2, is_auto_reply: 0, timestamp_email: '2026-11-09T15:00:00.000Z' },
        { id: 'em_2', lead_id: 'lead_42', ue_type: 2, is_auto_reply: 1, timestamp_email: '2026-11-09T15:01:00.000Z' },
        { id: 'em_3', lead_id: 'lead_unknown', ue_type: 2, is_auto_reply: 0, timestamp_email: '2026-11-09T15:02:00.000Z' },
      ],
    });
    const report = await syncInstantlyReplies(projectId, { fetch: fake.fetchImpl, env: ENV });
    expect(report).toMatchObject({ read: 3, recorded: 1, autoReplies: 1, unmatched: 1, skipped: null });
    const observed = await observationsFor(captured.value.id);
    expect(observed.map((o) => [o.kind, o.source, o.evidenceRef])).toEqual([['BUYER_REPLIED', 'PROVIDER', 'instantly:email:em_1']]);
    // A second pass records nothing twice, and only reads.
    expect((await syncInstantlyReplies(projectId, { fetch: fake.fetchImpl, env: ENV })).recorded).toBe(0);
    expect(fake.calls.every((c) => c.method === 'GET')).toBe(true);
    // Only Brain's campaign is read: never the owner's.
    expect(fake.calls.filter((c) => c.path.startsWith('/emails')).every((c) => c.path.includes('11111111-2222-3333-4444-555555555555'))).toBe(true);
  });
});
