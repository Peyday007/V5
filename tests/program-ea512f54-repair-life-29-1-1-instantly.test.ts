/**
 * LIFE-29-1 repair: a buyer's answer that Instantly itself states becomes the
 * observation that can stand behind an agreement. Won is BUYER_ACCEPTED, not
 * interested / lost is BUYER_DECLINED, anything else stays a plain reply, and
 * nothing is read from the words of the reply.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { capture } from '../server/services/cash/opportunities.ts';
import { recordAction } from '../server/repos/cashActions.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import { observationsFor } from '../server/repos/cashJourney.ts';
import { BRAIN_CAMPAIGN_NAME, answerFromInterestStatus } from '../server/services/cash/providers/instantly.ts';
import { syncInstantlyReplies } from '../server/services/cash/providers/instantlySync.ts';
import type { FetchLike } from '../server/services/cash/providers/http.ts';

const ENV = { BRAIN_MESSAGING_PROVIDER: 'instantly', INSTANTLY_API_KEY: 'instantly_test_key_life_29_1' } as NodeJS.ProcessEnv;
const CAMPAIGN = '22222222-3333-4444-5555-666666666666';

function fake(replies: Record<string, unknown>[]) {
  const methods: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    methods.push(String(init.method));
    const path = new URL(url).pathname.replace('/api/v2', '');
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    if (path.startsWith('/accounts')) return json({ items: [{ email: 'a@sender.example', status: 1, warmup_status: 1, daily_limit: 50 }] });
    if (path.startsWith('/campaigns')) return json({ items: [{ id: CAMPAIGN, name: BRAIN_CAMPAIGN_NAME, status: 1 }] });
    if (path.startsWith('/emails')) return json({ items: replies });
    return new Response('{}', { status: 404 });
  };
  return { fetchImpl, methods };
}

let projectId = '';
let opportunityId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const userId = (await createUser({ email: `life291-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash over the next few weeks.' })).ok).toBe(true);
  const captured = await capture({ projectId, actorRef: userId, ownerUserId: userId, title: 'Agency white-label articles', mechanism: 'OTHER', currency: 'USD' });
  if (!captured.ok) throw new Error(captured.reason);
  opportunityId = captured.value.id;
  const authority = await createAuthority({ projectId, ownerUserId: userId, createdByUserId: userId, name: 'grant', allowedActions: [...COMMERCIAL_ACTIONS], prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL], maxCommittedCents: 100_000, maxPerActionCents: 40_000, maxConcurrent: 3, currency: 'USD' });
  await recordAction({ projectId, opportunityId, authorityId: authority.id, action: 'CONTACT_BUYER', performedBy: 'BRAIN', reference: 'lead_7', detail: 'Reached via Instantly', confirmedBy: 'BRAIN', requestKey: `t:${opportunityId}` });
});

const reply = (id: string, extra: Record<string, unknown> = {}) => ({ id, lead_id: 'lead_7', campaign_id: CAMPAIGN, ue_type: 2, is_auto_reply: 0, timestamp_email: '2026-11-12T10:00:00.000Z', ...extra });

describe('the provider-stated answer', () => {
  it('reads only won as accepted and only not-interested or lost as declined', () => {
    expect(answerFromInterestStatus(4)).toBe('BUYER_ACCEPTED');
    expect(answerFromInterestStatus(-1)).toBe('BUYER_DECLINED');
    expect(answerFromInterestStatus(-3)).toBe('BUYER_DECLINED');
    for (const status of [null, 0, 1, 2, 3, -2]) expect(answerFromInterestStatus(status)).toBeNull();
  });
});

describe('syncInstantlyReplies records the answer Instantly states', () => {
  it('a won reply is BUYER_ACCEPTED from the provider, once, keyed by its email id; a later pass adds nothing', async () => {
    const f = fake([reply('em_won', { i_status: 4 })]);
    const first = await syncInstantlyReplies(projectId, { fetch: f.fetchImpl, env: ENV });
    expect(first).toMatchObject({ read: 1, recorded: 1, answers: 1, skipped: null });
    const observed = await observationsFor(opportunityId);
    const accepted = observed.filter((o) => o.kind === 'BUYER_ACCEPTED');
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ source: 'PROVIDER', evidenceRef: 'instantly:email:em_won:i_status:4', amountCents: null });
    expect(observed.filter((o) => o.kind === 'BUYER_REPLIED')).toHaveLength(1);
    const second = await syncInstantlyReplies(projectId, { fetch: f.fetchImpl, env: ENV });
    expect(second).toMatchObject({ recorded: 0, answers: 0 });
    expect((await observationsFor(opportunityId)).filter((o) => o.kind === 'BUYER_ACCEPTED')).toHaveLength(1);
    expect(f.methods.every((m) => m === 'GET')).toBe(true);
  });

  it('a status set after the reply was first read is still recorded on the next pass', async () => {
    await syncInstantlyReplies(projectId, { fetch: fake([reply('em_late')]).fetchImpl, env: ENV });
    expect((await observationsFor(opportunityId)).map((o) => o.kind)).toEqual(['BUYER_REPLIED']);
    const later = await syncInstantlyReplies(projectId, { fetch: fake([reply('em_late', { i_status: -1 })]).fetchImpl, env: ENV });
    expect(later).toMatchObject({ recorded: 0, answers: 1 });
    expect((await observationsFor(opportunityId)).map((o) => o.kind).sort()).toEqual(['BUYER_DECLINED', 'BUYER_REPLIED']);
  });

  it('a reply with no answer stated stays BUYER_REPLIED, interest is not acceptance, and auto-replies are still skipped', async () => {
    const report = await syncInstantlyReplies(projectId, {
      fetch: fake([reply('em_plain'), reply('em_interested', { i_status: 1 }), reply('em_auto', { is_auto_reply: 1, i_status: 4 })]).fetchImpl,
      env: ENV,
    });
    expect(report).toMatchObject({ read: 3, recorded: 2, answers: 0, autoReplies: 1 });
    expect((await observationsFor(opportunityId)).every((o) => o.kind === 'BUYER_REPLIED')).toBe(true);
  });
});
