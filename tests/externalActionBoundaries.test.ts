/**
 * External actions (§51): the boundaries release acceptance asks about.
 *
 * `externalActions.test.ts` walks the ordinary path. This file walks the
 * edges, each against a scripted provider that behaves the way the real one
 * does — ntfy keeps what it was given and can be read back, Resend and Stripe
 * de-duplicate on the idempotency key — so that "exactly once" is a count of
 * what the provider holds rather than a count of calls Brain made:
 *
 *   - the provider accepted, and Brain died before recording the receipt;
 *   - Brain recorded the intent, and the provider never received it (or
 *     nobody can tell);
 *   - a restart after the provider's key window has passed;
 *   - an invoice's issued / attempted / paid / settled / fee / net, and test
 *     money never becoming a ledger fact;
 *   - an email accepted is not an email delivered;
 *   - a provider identifier that names somebody else's object;
 *   - project isolation of connections, actions and keys;
 *   - Russell's entrance, through a real turn, where a proposal is never an
 *     approval and a recipient must be the person's own words;
 *   - a Brain-performed commercial act without provider evidence, refused at
 *     the only writer.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createProject } from '../server/repos/projects.ts';
import { createUser, createWorker, grantMembership } from '../server/repos/identity.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createOpportunity } from '../server/repos/cashPortfolio.ts';
import { recordAction, actionsFor } from '../server/repos/cashActions.ts';
import { cashPosition } from '../server/services/cash/money.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import { createConversation, listTurns } from '../server/repos/russellConversations.ts';
import { getDb } from '../server/db/database.ts';
import { setProviderFetch } from '../server/services/external/http.ts';
import { checkConnection, connect } from '../server/services/external/connections.ts';
import {
  approveAction,
  executeAction,
  externalActionsTick,
  notifyWaitingDecisions,
  prepareAction,
  readBack,
  resolveUncertain,
} from '../server/services/external/actions.ts';
import { getAction, listActions } from '../server/repos/externalActions.ts';
import { resendReading } from '../server/services/external/drivers.ts';
import { beginTurn, TURN_UNIT_KEY } from '../server/services/russell/turn.ts';
import { assignNextBin, putBinUnitResult, releaseBin } from '../server/repos/bins.ts';
import { requestCompletion } from '../server/services/bins/service.ts';
import { hashUnitValue } from '../server/services/bins/contracts.ts';
import { tick } from '../server/services/russell/loop.ts';
import type { Principal, ProjectMembership } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
const envNames: string[] = [];

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
let handler: Handler = () => new Response('{}', { status: 500 });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A promise that never settles: the process "dies" inside the provider call. */
function hang(): Promise<Response> {
  return new Promise<Response>(() => undefined);
}

async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition never held');
}

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `boundary-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  setProviderFetch((async (url: string | URL | Request, init?: RequestInit) => await handler(String(url), init ?? {})) as typeof fetch);
});

afterEach(() => {
  setProviderFetch(null);
  for (const name of envNames.splice(0)) delete process.env[name];
});

function deploy(name: string, value: string): void {
  process.env[name] = value;
  envNames.push(name);
}

/** Ten minutes on: long enough that a SENDING row belongs to a dead executor. */
function later(minutes = 10): Date {
  return new Date(Date.now() + minutes * 60_000);
}

/* ------------------------------------------------------------------------- */
/* Scripted providers that hold state the way the real ones do               */
/* ------------------------------------------------------------------------- */

const TOPIC = 'brain-boundary-topic-0123456789';

interface NtfyFake {
  messages: Array<{ id: string; tags: string[]; time: number }>;
  posts: number;
  mode: 'normal' | 'accept-then-die' | 'never-received';
}

async function ntfyWith(fake: NtfyFake, project = projectId) {
  const { connection } = await connect({ projectId: project, provider: 'NTFY', actorRef: userId });
  deploy(connection.secretName, TOPIC);
  handler = (url, init) => {
    if (url.endsWith('/v1/health')) return json({ healthy: true });
    if (init.method === 'POST') {
      fake.posts += 1;
      if (fake.mode === 'never-received') throw new TypeError('connect ECONNRESET');
      const body = JSON.parse(String(init.body)) as { tags: string[] };
      const message = { id: `nt${fake.messages.length + 1}`, tags: body.tags, time: 1_790_000_000 };
      fake.messages.push(message);
      if (fake.mode === 'accept-then-die') return hang();
      return json({ ...message, event: 'message' });
    }
    if (url.includes('/json?poll=1')) {
      return new Response(fake.messages.map((one) => JSON.stringify({ ...one, event: 'message' })).join('\n'));
    }
    return json({}, 404);
  };
  await checkConnection(connection.id, userId);
  return connection;
}

interface ResendFake {
  byKey: Map<string, string>;
  emails: Map<string, { to: string[]; last_event: string }>;
  posts: number;
  keys: string[];
  mode: 'normal' | 'accept-then-die' | 'transport-error';
}

async function resendWith(fake: ResendFake) {
  const { connection } = await connect({ projectId, provider: 'RESEND', sender: 'brain@owned.test', selfDestination: 'owner@owned.test', actorRef: userId });
  deploy(connection.secretName, 're_testkey_abcdefghij');
  handler = (url, init) => {
    if (url.endsWith('/domains')) return json({ data: [{ status: 'verified' }] });
    if (init.method === 'POST' && url.endsWith('/emails')) {
      fake.posts += 1;
      if (fake.mode === 'transport-error') throw new TypeError('socket hang up');
      const key = new Headers(init.headers).get('idempotency-key') ?? '';
      fake.keys.push(key);
      let id = fake.byKey.get(key);
      if (!id) {
        id = `em${fake.emails.size + 1}`;
        fake.byKey.set(key, id);
        const body = JSON.parse(String(init.body)) as { to: string[] };
        fake.emails.set(id, { to: body.to, last_event: 'sent' });
      }
      if (fake.mode === 'accept-then-die') return hang();
      return json({ id });
    }
    const match = /\/emails\/([^/?]+)$/.exec(url);
    if (match) {
      const email = fake.emails.get(match[1]!);
      return email ? json({ id: match[1], ...email }) : json({}, 404);
    }
    return json({}, 404);
  };
  await checkConnection(connection.id, userId);
  return connection;
}

async function grantEverything(): Promise<void> {
  await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash over the next few weeks.' });
  await createAuthority({
    projectId, ownerUserId: userId, createdByUserId: userId, name: 'grant',
    allowedActions: [...COMMERCIAL_ACTIONS], prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
    maxCommittedCents: 100_000, maxPerActionCents: 40_000, maxConcurrent: 3, currency: 'USD',
  });
}

async function anOpening(): Promise<string> {
  const mode = await getCashMode(projectId);
  const opening = await createOpportunity({
    projectId, cashModeId: mode!.id, ownerUserId: userId,
    title: 'A buyer who asked for this', mechanism: 'EXPLICIT_PAID_REQUEST', currency: 'USD',
  });
  return opening.id;
}

/* ------------------------------------------------------------------------- */

describe('the provider accepted it, and Brain died before recording the receipt', () => {
  it('ntfy: a restart asks the provider, finds the one message, and never publishes a second', async () => {
    const fake: NtfyFake = { messages: [], posts: 0, mode: 'accept-then-die' };
    await ntfyWith(fake);
    const conversation = await createConversation({ ownerUserId: userId, title: 'crash', projectId });
    const prepared = await prepareAction({ projectId, kind: 'NOTIFY_OWNER', content: { subject: 'Hi', body: 'x' }, conversationId: conversation.id, requestedByType: 'HUMAN', requestedBy: userId });
    if (!prepared.ok) throw new Error(prepared.reason);

    void executeAction(prepared.action.id); // dies inside the provider call
    await until(() => fake.messages.length === 1);
    await until(async () => (await getAction(prepared.action.id))!.state === 'SENDING');

    // Nothing is claimed while the outcome is unknown.
    const midway = (await getAction(prepared.action.id))!;
    expect(midway.providerRef).toBeNull();
    expect(midway.readbackState).toBeNull();
    expect(midway.returnedAt).toBeNull();

    // The restart. The provider behaves normally now; the executor is gone.
    fake.mode = 'normal';
    const report = await executeAction(prepared.action.id, later());
    expect(report.state).toBe('CONFIRMED');
    const done = (await getAction(prepared.action.id))!;
    expect(done.providerRef).toBe('nt1');
    expect(done.readbackState).toBe('PUBLISHED');
    expect(fake.posts).toBe(1);
    expect(fake.messages).toHaveLength(1);

    // And ticking afterwards changes nothing out there.
    await externalActionsTick(later(20));
    await externalActionsTick(later(30));
    expect(fake.posts).toBe(1);
    expect(JSON.stringify(await listTurns(conversation.id))).toContain('nt1');
  });

  it('Resend: a restart repeats the same key inside the window, so the provider holds one email', async () => {
    const fake: ResendFake = { byKey: new Map(), emails: new Map(), posts: 0, keys: [], mode: 'accept-then-die' };
    await resendWith(fake);
    const prepared = await prepareAction({ projectId, kind: 'SEND_EMAIL', destination: 'owner@owned.test', content: { subject: 'Self', body: 'x' }, requestedByType: 'HUMAN', requestedBy: userId });
    if (!prepared.ok) throw new Error(prepared.reason);
    expect((await approveAction({ actionId: prepared.action.id, approverUserId: userId })).ok).toBe(true);

    void executeAction(prepared.action.id);
    await until(() => fake.emails.size === 1);
    fake.mode = 'normal';
    const report = await executeAction(prepared.action.id, later());
    expect(report.state).toBe('CONFIRMED');
    expect(fake.posts).toBe(2);
    expect(fake.keys[0]).toBe(fake.keys[1]);
    expect(fake.emails.size).toBe(1);
    expect((await getAction(prepared.action.id))!.providerRef).toBe('em1');
  });

  it('Resend: a restart after the provider has forgotten the key stops at UNCERTAIN instead of sending twice', async () => {
    const fake: ResendFake = { byKey: new Map(), emails: new Map(), posts: 0, keys: [], mode: 'accept-then-die' };
    await resendWith(fake);
    const conversation = await createConversation({ ownerUserId: userId, title: 'late', projectId });
    const prepared = await prepareAction({ projectId, kind: 'SEND_EMAIL', destination: 'owner@owned.test', content: { subject: 'Self', body: 'y' }, conversationId: conversation.id, requestedByType: 'HUMAN', requestedBy: userId });
    if (!prepared.ok) throw new Error(prepared.reason);
    await approveAction({ actionId: prepared.action.id, approverUserId: userId });

    void executeAction(prepared.action.id);
    await until(() => fake.emails.size === 1);
    fake.mode = 'normal';
    fake.byKey.clear(); // a day on, Resend no longer knows the key
    const report = await executeAction(prepared.action.id, later(25 * 60));
    expect(report.state).toBe('UNCERTAIN');
    expect(fake.posts).toBe(1);
    expect(fake.emails.size).toBe(1);
    const turns = JSON.stringify(await listTurns(conversation.id));
    expect(turns).toContain('Unknown');
    expect(turns).not.toContain('accepted it and returned');
  });

  it('Stripe: every step repeated under its own key, so one customer, one invoice, one line', async () => {
    const created = { customers: 0, invoices: 0, items: 0 };
    const seen = new Map<string, Response>();
    let tag = '';
    let dieAtSend = true;
    const { connection } = await connect({ projectId, provider: 'STRIPE', selfDestination: 'owner@owned.test', actorRef: userId });
    deploy(connection.secretName, 'sk_test_abcdefghijklmnop');
    handler = async (url, init) => {
      if (url.endsWith('/balance')) return json({ livemode: false });
      const key = new Headers(init.headers).get('idempotency-key');
      if (key && seen.has(key)) return seen.get(key)!.clone();
      let reply: Response;
      if (url.endsWith('/customers')) { created.customers += 1; reply = json({ id: 'cus_1' }); }
      else if (url.endsWith('/invoices')) {
        created.invoices += 1;
        tag = new URLSearchParams(String(init.body)).get('metadata[brain]') ?? '';
        reply = json({ id: 'in_1' });
      }
      else if (url.endsWith('/invoiceitems')) { created.items += 1; reply = json({ id: 'ii_1' }); }
      else if (url.endsWith('/finalize')) reply = json({ id: 'in_1', status: 'open' });
      else if (url.endsWith('/send')) {
        reply = json({ id: 'in_1', status: 'open', livemode: false });
        if (key) seen.set(key, reply.clone());
        if (dieAtSend) return await hang();
        return reply;
      }
      else if (url.includes('/invoices/in_1?')) return json({ id: 'in_1', status: 'open', amount_due: 900, livemode: false, metadata: { brain: tag } });
      else return json({}, 404);
      if (key) seen.set(key, reply.clone());
      return reply;
    };
    await checkConnection(connection.id, userId);
    const prepared = await prepareAction({ projectId, kind: 'ISSUE_INVOICE', destination: 'owner@owned.test', currency: 'usd', content: { lines: [{ description: 'Work', amountCents: 900 }] }, requestedByType: 'HUMAN', requestedBy: userId });
    if (!prepared.ok) throw new Error(prepared.reason);
    await approveAction({ actionId: prepared.action.id, approverUserId: userId });
    void executeAction(prepared.action.id);
    await until(() => seen.size === 5);
    dieAtSend = false;
    const report = await executeAction(prepared.action.id, later());
    expect(report.state).toBe('CONFIRMED');
    expect(created).toEqual({ customers: 1, invoices: 1, items: 1 });
    expect((await getAction(prepared.action.id))!.readbackState).toBe('ISSUED');
  });
});

describe('the intent was recorded, and the provider never received it or nobody can tell', () => {
  it('ntfy: stays UNCERTAIN, claims nothing, and is never sent again however long Brain waits', async () => {
    const fake: NtfyFake = { messages: [], posts: 0, mode: 'never-received' };
    await ntfyWith(fake);
    const conversation = await createConversation({ ownerUserId: userId, title: 'lost', projectId });
    const prepared = await prepareAction({ projectId, kind: 'NOTIFY_OWNER', content: { subject: 'Hi', body: 'z' }, conversationId: conversation.id, requestedByType: 'HUMAN', requestedBy: userId });
    if (!prepared.ok) throw new Error(prepared.reason);
    expect((await executeAction(prepared.action.id)).state).toBe('UNCERTAIN');

    fake.mode = 'normal'; // the provider is fine now, and the topic is empty
    for (const minutes of [10, 60, 600, 3000]) {
      await externalActionsTick(later(minutes));
      await executeAction(prepared.action.id, later(minutes));
    }
    expect(fake.posts).toBe(1);
    expect(fake.messages).toHaveLength(0);
    const action = (await getAction(prepared.action.id))!;
    expect(action.state).toBe('UNCERTAIN');
    expect(action.providerRef).toBeNull();
    expect(action.readbackState).toBeNull();
    const turns = JSON.stringify(await listTurns(conversation.id));
    expect(turns).toContain('Unknown');
    expect(turns).not.toContain('accepted it');
    // Nothing was said to have happened anywhere a reader would look.
    const events = await getDb().all<{ event_type: string; payload: string }>(
      "SELECT event_type, payload FROM project_events WHERE project_id = ? AND event_type = 'EXTERNAL_ACTION_RESULT'",
      [projectId],
    );
    expect(events.map((one) => JSON.parse(one.payload).state)).toEqual(['UNCERTAIN']);
  });

  it('Resend: a transport error before any reply is retried only under the same key, and never reads as sent', async () => {
    const fake: ResendFake = { byKey: new Map(), emails: new Map(), posts: 0, keys: [], mode: 'transport-error' };
    await resendWith(fake);
    const prepared = await prepareAction({ projectId, kind: 'SEND_EMAIL', destination: 'owner@owned.test', content: { subject: 'S', body: 'b' }, requestedByType: 'HUMAN', requestedBy: userId });
    if (!prepared.ok) throw new Error(prepared.reason);
    await approveAction({ actionId: prepared.action.id, approverUserId: userId });
    expect((await executeAction(prepared.action.id)).state).toBe('APPROVED');
    const waiting = (await getAction(prepared.action.id))!;
    expect(waiting.providerRef).toBeNull();
    expect(waiting.readbackState).toBeNull();
    expect(waiting.nextAttemptAt).not.toBeNull();
    fake.mode = 'normal';
    await getDb().run('UPDATE external_actions SET next_attempt_at = ? WHERE id = ?', [new Date(0).toISOString(), prepared.action.id]);
    expect((await executeAction(prepared.action.id)).state).toBe('CONFIRMED');
    expect(fake.emails.size).toBe(1);
  });
});

describe('an email accepted is not an email delivered', () => {
  it('maps every Resend event, and only a delivery reads DELIVERED', () => {
    for (const accepted of ['queued', 'scheduled', 'sent']) expect(resendReading(accepted).state).toBe('ACCEPTED');
    expect(resendReading('delivery_delayed').state).toBe('DELAYED');
    expect(resendReading('delivered').state).toBe('DELIVERED');
    expect(resendReading('bounced').state).toBe('BOUNCED');
    expect(resendReading('failed').state).toBe('FAILED');
    expect(resendReading('something_new').state).toBe('UNKNOWN_EVENT');
    expect(resendReading('sent').final).toBe(false);
  });

  it('says "accepted" to the conversation, then reports delivery only when Resend does', async () => {
    const fake: ResendFake = { byKey: new Map(), emails: new Map(), posts: 0, keys: [], mode: 'normal' };
    await resendWith(fake);
    const conversation = await createConversation({ ownerUserId: userId, title: 'mail', projectId });
    const prepared = await prepareAction({ projectId, kind: 'SEND_EMAIL', destination: 'owner@owned.test', content: { subject: 'S', body: 'b' }, conversationId: conversation.id, requestedByType: 'HUMAN', requestedBy: userId });
    if (!prepared.ok) throw new Error(prepared.reason);
    await approveAction({ actionId: prepared.action.id, approverUserId: userId });
    await executeAction(prepared.action.id);
    expect((await getAction(prepared.action.id))!.readbackState).toBe('ACCEPTED');
    const before = (await listTurns(conversation.id)).map((one) => one.content).join('\n');
    expect(before).toContain('accepted it');
    expect(before).not.toMatch(/Done:|reads DELIVERED|DELIVERED:/);

    fake.emails.get('em1')!.last_event = 'delivered';
    await readBack(prepared.action.id);
    expect((await getAction(prepared.action.id))!.readbackState).toBe('DELIVERED');
    expect((await listTurns(conversation.id)).at(-1)!.content).toContain('receiving server accepted delivery');
  });
});

describe('an invoice: issued, attempted, paid, settled, fee and net, and test money is not money', () => {
  async function liveStripe(invoice: () => Record<string, unknown>) {
    const { connection } = await connect({ projectId, provider: 'STRIPE', selfDestination: 'owner@owned.test', actorRef: userId });
    deploy(connection.secretName, 'sk_live_abcdefghijklmnop');
    const state = { tag: '' };
    handler = (url, init) => {
      if (url.endsWith('/balance')) return json({ livemode: true });
      if (url.endsWith('/customers')) return json({ id: 'cus_9' });
      if (url.endsWith('/invoices')) {
        state.tag = new URLSearchParams(String(init.body)).get('metadata[brain]') ?? '';
        return json({ id: 'in_9' });
      }
      if (url.endsWith('/invoiceitems')) return json({ id: 'ii_9' });
      if (url.endsWith('/finalize') || url.endsWith('/send')) return json({ id: 'in_9', status: 'open', livemode: true });
      if (url.includes('/invoices/in_9?')) return json({ id: 'in_9', metadata: { brain: state.tag }, ...invoice() });
      return json({}, 404);
    };
    await checkConnection(connection.id, userId);
  }

  it('keeps six facts apart and writes only what each one establishes', async () => {
    await grantEverything();
    const opening = await anOpening();
    let invoice: Record<string, unknown> = { status: 'open', amount_due: 2500, livemode: true };
    await liveStripe(() => invoice);
    const prepared = await prepareAction({ projectId, kind: 'ISSUE_INVOICE', destination: 'buyer@example.test', currency: 'USD', opportunityId: opening, content: { lines: [{ description: 'Work', amountCents: 2500 }] }, requestedByType: 'HUMAN', requestedBy: userId });
    if (!prepared.ok) throw new Error(prepared.reason);
    expect(prepared.action.commercialAction).toBe('QUOTE_AND_INVOICE');
    await approveAction({ actionId: prepared.action.id, approverUserId: userId });
    expect((await executeAction(prepared.action.id)).state).toBe('CONFIRMED');
    const ledger = async () =>
      (await getDb().all<{ kind: string; amount_cents: number }>('SELECT kind, amount_cents FROM cash_money_entries WHERE project_id = ? ORDER BY kind', [projectId]))
        .map((one) => `${one.kind}:${Number(one.amount_cents)}`);

    // Issued.
    expect((await getAction(prepared.action.id))!.readbackState).toBe('ISSUED');
    expect(await ledger()).toEqual([]);

    // A payment attempted and declined moves no money.
    invoice = { status: 'open', amount_due: 2500, attempted: true, attempt_count: 1, livemode: true };
    await readBack(prepared.action.id);
    expect((await getAction(prepared.action.id))!.readbackState).toBe('PAYMENT_ATTEMPTED');
    expect(await ledger()).toEqual([]);

    // Paid, not yet available: a customer payment, not cash.
    invoice = { status: 'paid', amount_paid: 2500, livemode: true, charge: { balance_transaction: { id: 'txn_9', status: 'pending', fee: 103, net: 2397 } } };
    await readBack(prepared.action.id);
    expect((await getAction(prepared.action.id))!.readbackState).toBe('PAYMENT_MADE');
    expect(await ledger()).toEqual(['CUSTOMER_PAYMENT:2500']);

    // Available: the settlement, gross, and the fee the provider kept.
    invoice = { status: 'paid', amount_paid: 2500, livemode: true, charge: { balance_transaction: { id: 'txn_9', status: 'available', fee: 103, net: 2397 } } };
    await readBack(prepared.action.id);
    const settled = (await getAction(prepared.action.id))!;
    expect(settled.readbackState).toBe('FUNDS_SETTLED');
    expect(settled.readbackDetail).toContain('Stripe kept 103 and 2397 reached the balance');
    expect(await ledger()).toEqual(['COST:103', 'CUSTOMER_PAYMENT:2500', 'SETTLEMENT:2500']);
    const position = await cashPosition({ projectId, currency: 'USD' });
    expect(position.availableFundsCents).toBe(2397); // net, not gross

    // Read again: nothing is counted twice.
    await readBack(prepared.action.id);
    await externalActionsTick(later(5));
    expect(await ledger()).toEqual(['COST:103', 'CUSTOMER_PAYMENT:2500', 'SETTLEMENT:2500']);

    // And the opening carries the invoice as its commercial act, by the provider's id.
    const acts = await actionsFor(opening);
    expect(acts.map((one) => [one.action, one.performedBy, one.reference])).toEqual([['QUOTE_AND_INVOICE', 'BRAIN', 'in_9']]);
  });

  it('never writes a test-mode invoice to the ledger, even through a live connection', async () => {
    await grantEverything();
    const opening = await anOpening();
    await liveStripe(() => ({ status: 'paid', amount_paid: 2500, livemode: false, charge: { balance_transaction: { id: 'txn_t', status: 'available', fee: 103, net: 2397 } } }));
    const prepared = await prepareAction({ projectId, kind: 'ISSUE_INVOICE', destination: 'buyer@example.test', currency: 'USD', opportunityId: opening, content: { lines: [{ description: 'Work', amountCents: 2500 }] }, requestedByType: 'HUMAN', requestedBy: userId });
    if (!prepared.ok) throw new Error(prepared.reason);
    await approveAction({ actionId: prepared.action.id, approverUserId: userId });
    await executeAction(prepared.action.id);
    expect((await getAction(prepared.action.id))!.readbackState).toBe('FUNDS_SETTLED');
    expect(await getDb().all('SELECT * FROM cash_money_entries WHERE project_id = ?', [projectId])).toHaveLength(0);
  });

  it('never writes to the ledger through a test-mode connection, whatever an invoice says about itself', async () => {
    await grantEverything();
    const opening = await anOpening();
    const { connection } = await connect({ projectId, provider: 'STRIPE', selfDestination: 'owner@owned.test', actorRef: userId });
    deploy(connection.secretName, 'sk_test_abcdefghijklmnop');
    let tag = '';
    handler = (url, init) => {
      if (url.endsWith('/balance')) return json({ livemode: false });
      if (url.endsWith('/invoices')) { tag = new URLSearchParams(String(init.body)).get('metadata[brain]') ?? ''; return json({ id: 'in_t' }); }
      if (url.includes('/invoices/in_t?')) return json({ id: 'in_t', metadata: { brain: tag }, status: 'paid', amount_paid: 800, livemode: true, charge: { balance_transaction: { id: 'txn_x', status: 'available', fee: 1, net: 799 } } });
      return json({ id: 'x', status: 'open' });
    };
    await checkConnection(connection.id, userId);
    const prepared = await prepareAction({ projectId, kind: 'ISSUE_INVOICE', destination: 'owner@owned.test', currency: 'USD', opportunityId: opening, content: { lines: [{ description: 'Test', amountCents: 800 }] }, requestedByType: 'HUMAN', requestedBy: userId });
    if (!prepared.ok) throw new Error(prepared.reason);
    await approveAction({ actionId: prepared.action.id, approverUserId: userId });
    await executeAction(prepared.action.id);
    expect(await getDb().all('SELECT * FROM cash_money_entries WHERE project_id = ?', [projectId])).toHaveLength(0);
  });

  it('refuses to read a person-supplied identifier onto this action when it names somebody else’s invoice', async () => {
    await grantEverything();
    const opening = await anOpening();
    await liveStripe(() => ({ status: 'open', livemode: true }));
    handler = (url) => {
      if (url.includes('/invoices/in_other?')) return json({ id: 'in_other', metadata: { brain: 'brn-someoneelse' }, status: 'paid', amount_paid: 99_999, livemode: true, charge: { balance_transaction: { id: 'txn_o', status: 'available' } } });
      if (url.endsWith('/send')) throw new TypeError('socket hang up');
      return json({ id: 'z', status: 'open' });
    };
    const prepared = await prepareAction({ projectId, kind: 'ISSUE_INVOICE', destination: 'buyer@example.test', currency: 'USD', opportunityId: opening, content: { lines: [{ description: 'Work', amountCents: 2500 }] }, requestedByType: 'HUMAN', requestedBy: userId });
    if (!prepared.ok) throw new Error(prepared.reason);
    await approveAction({ actionId: prepared.action.id, approverUserId: userId });
    await getDb().run("UPDATE external_actions SET state = 'UNCERTAIN' WHERE id = ?", [prepared.action.id]);
    expect((await resolveUncertain({ actionId: prepared.action.id, actorRef: userId, outcome: 'HAPPENED', providerRef: 'in_other', note: 'I think this is it' })).ok).toBe(true);
    expect((await getAction(prepared.action.id))!.readbackState).toBe('NOT_THIS_ACTION');
    expect(await getDb().all('SELECT * FROM cash_money_entries WHERE project_id = ?', [projectId])).toHaveLength(0);
  });
});

describe('projects are separate', () => {
  it('a connection, an action and a key in one project reach nothing in another', async () => {
    const other = await createProject({ name: 'Other', slug: `other-${Date.now()}` });
    const fake: NtfyFake = { messages: [], posts: 0, mode: 'normal' };
    await ntfyWith(fake, projectId);

    // The other project has no connection of its own, and cannot borrow this one.
    const refused = await prepareAction({ projectId: other.id, kind: 'NOTIFY_OWNER', content: { subject: 'x', body: 'y' }, requestedByType: 'HUMAN', requestedBy: userId });
    expect(refused.ok).toBe(false);

    // The same server-built key in two projects is two actions, not one.
    const here = await prepareAction({ projectId, kind: 'NOTIFY_OWNER', content: { subject: 'x', body: 'y' }, requestedByType: 'HUMAN', requestedBy: userId, requestKey: 'same-key' });
    expect(here.ok).toBe(true);
    const connectionThere = await connect({ projectId: other.id, provider: 'NTFY', actorRef: userId });
    deploy(connectionThere.connection.secretName, TOPIC + '-other');
    await checkConnection(connectionThere.connection.id, userId);
    const there = await prepareAction({ projectId: other.id, kind: 'NOTIFY_OWNER', content: { subject: 'x', body: 'y' }, requestedByType: 'HUMAN', requestedBy: userId, requestKey: 'same-key' });
    expect(there.ok && here.ok && there.action.id !== here.action.id).toBe(true);
    if (!here.ok || !there.ok) return;
    expect(here.action.connectionId).not.toBe(there.action.connectionId);

    // An opening or a conversation from another project is refused, not attached.
    const conversationThere = await createConversation({ ownerUserId: userId, title: 't', projectId: other.id });
    const crossed = await prepareAction({ projectId, kind: 'NOTIFY_OWNER', content: { subject: 'x', body: 'z' }, conversationId: conversationThere.id, requestedByType: 'HUMAN', requestedBy: userId });
    expect(crossed.ok).toBe(false);

    // Listing is by project.
    expect((await listActions(projectId, 50)).every((one) => one.projectId === projectId)).toBe(true);
    expect((await listActions(other.id, 50)).map((one) => one.id)).toEqual([there.action.id]);

    // Every action route resolves the action inside the addressed project.
    const source = await import('node:fs').then((fs) => fs.readFileSync('server/routes/external.ts', 'utf8'));
    const actionRoutes = (source.match(/externalRouter\.(get|post)\(\s*'\/projects\/:projectId\/external\/actions\/:actionId/g) ?? []).length;
    const guarded = source.split('await actionIn(project.id, pathId(req, \'actionId\'))').length - 1;
    expect(actionRoutes).toBe(5); // approve, cancel, resolve, refresh, read
    expect(guarded).toBe(actionRoutes);
  });
});

describe('a notification never notifies about itself', () => {
  it('pushes once per waiting decision, never about a notification, and stops at the daily bound', async () => {
    const fake: NtfyFake = { messages: [], posts: 0, mode: 'normal' };
    await ntfyWith(fake);
    const email = await connect({ projectId, provider: 'RESEND', sender: 'brain@owned.test', selfDestination: 'owner@owned.test', actorRef: userId });
    deploy(email.connection.secretName, 're_testkey_abcdefghij');
    const ntfy = handler;
    handler = (url, init) => (url.endsWith('/domains') ? json({ data: [{ status: 'verified' }] }) : ntfy(url, init));
    await checkConnection(email.connection.id, userId);
    for (let i = 0; i < 35; i += 1) {
      await prepareAction({ projectId, kind: 'SEND_EMAIL', destination: 'owner@owned.test', content: { subject: `s${i}`, body: 'b' }, requestedByType: 'HUMAN', requestedBy: userId });
    }
    for (let i = 0; i < 4; i += 1) await externalActionsTick(later(i));
    expect(fake.posts).toBe(30);
    const notifications = (await listActions(projectId, 200)).filter((one) => one.kind === 'NOTIFY_OWNER');
    expect(notifications).toHaveLength(30);
    expect(notifications.every((one) => one.requestedBy === 'external-actions' && !one.approvalRequired)).toBe(true);
    // None of them is itself something waiting, so none produced another.
    expect(await notifyWaitingDecisions(projectId)).toBe(0);
  });
});

describe('Brain performing a commercial act is a fact only with provider evidence', () => {
  it('refuses a BRAIN row with no confirmed external action behind it, from any caller', async () => {
    await grantEverything();
    const opening = await anOpening();
    const authority = (await getDb().get<{ id: string }>('SELECT id FROM cash_authorities WHERE project_id = ?', [projectId]))!;
    await expect(
      recordAction({
        projectId, opportunityId: opening, authorityId: authority.id, action: 'CONTACT_BUYER',
        performedBy: 'BRAIN', reference: 'em-invented', detail: 'Contacted the buyer.', confirmedBy: 'x', requestKey: 'k1',
      }),
    ).rejects.toThrow(/no provider-confirmed external action/);
    // A person saying what they did themselves is still theirs to record, and says so.
    const theirs = await recordAction({
      projectId, opportunityId: opening, authorityId: authority.id, action: 'CONTACT_BUYER',
      performedBy: 'PERSON', reference: null, detail: 'I phoned them.', confirmedBy: userId, requestKey: 'k2',
    });
    expect(theirs.action.performedBy).toBe('PERSON');
  });

  it('a provider-confirmed email records the contact on the opening, once, as the provider named it', async () => {
    await grantEverything();
    const opening = await anOpening();
    const fake: ResendFake = { byKey: new Map(), emails: new Map(), posts: 0, keys: [], mode: 'normal' };
    await resendWith(fake);
    const prepared = await prepareAction({ projectId, kind: 'SEND_EMAIL', destination: 'buyer@example.test', opportunityId: opening, content: { subject: 'Offer', body: 'Hello' }, requestedByType: 'HUMAN', requestedBy: userId });
    if (!prepared.ok) throw new Error(prepared.reason);
    await approveAction({ actionId: prepared.action.id, approverUserId: userId });
    await executeAction(prepared.action.id);
    await externalActionsTick(later());
    const acts = await actionsFor(opening);
    expect(acts.map((one) => [one.action, one.performedBy, one.reference])).toEqual([['CONTACT_BUYER', 'BRAIN', 'em1']]);
    const cashEvents = await getDb().all<{ kind: string }>("SELECT kind FROM cash_events WHERE opportunity_id = ? AND kind = 'CASH_EXTERNAL_ACTION'", [opening]);
    expect(cashEvents).toHaveLength(1);
    const results = await getDb().all("SELECT id FROM project_events WHERE project_id = ? AND event_type = 'EXTERNAL_ACTION_RESULT'", [projectId]);
    expect(results).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------- */
/* Russell's entrance, through a real turn                                    */
/* ------------------------------------------------------------------------- */

describe('Russell may propose; a proposal is never an approval', () => {
  function principal(): Principal {
    return {
      type: 'HUMAN', id: userId, handle: 'owner@example.test', displayName: 'Owner', isBrainAdmin: false,
      mustChangePassword: false, credentialId: 'ses_test', authMethod: 'SESSION_COOKIE',
      memberships: [{ id: 'mem', projectId, principalType: 'HUMAN', principalId: userId, role: 'MEMBER', scopes: ['project:read'], grantedByType: 'SYSTEM', grantedById: 't', grantedAt: '2026-01-01T00:00:00.000Z', active: true } as ProjectMembership],
      requestId: 'req',
    } as Principal;
  }

  async function turn(conversationId: string, content: string, proposal: Record<string, unknown>): Promise<void> {
    const started = await beginTurn({ principal: principal(), conversationId, content });
    expect(started.binId).toBeTruthy();
    const workerId = (await createWorker({ name: `w-${Math.random().toString(36).slice(2, 8)}`, createdByType: 'SYSTEM', createdById: 't' })).id;
    let assigned: Awaited<ReturnType<typeof assignNextBin>> = null;
    for (let i = 0; i < 8; i += 1) {
      const offered = await assignNextBin({ workerId, projectIds: [projectId] });
      if (!offered) break;
      if (offered.bin.id === started.binId) { assigned = offered; break; }
      await releaseBin({ binId: offered.bin.id, leaseId: offered.leaseId, leaseGeneration: offered.leaseGeneration, workerId });
    }
    if (!assigned) throw new Error('the turn was never offered');
    const value = JSON.stringify(proposal);
    await putBinUnitResult({ binId: started.binId!, unitKey: TURN_UNIT_KEY, value, contentHash: hashUnitValue(value), leaseId: assigned.leaseId, leaseGeneration: assigned.leaseGeneration, submittedBy: workerId });
    await requestCompletion({ workerId, proof: { binId: started.binId!, leaseId: assigned.leaseId, leaseGeneration: assigned.leaseGeneration, workerId } });
    await tick('external-entrance');
  }

  beforeEach(async () => {
    await grantMembership({ projectId, principalType: 'HUMAN', principalId: userId, role: 'MEMBER', scopes: ['project:read'], grantedByType: 'SYSTEM', grantedById: 'test' });
  });

  it('a turn prepares an email that waits for approval, and nothing is sent however it is worded', async () => {
    await grantEverything();
    const fake: ResendFake = { byKey: new Map(), emails: new Map(), posts: 0, keys: [], mode: 'normal' };
    await resendWith(fake);
    const conversation = await createConversation({ ownerUserId: userId, title: 'Email', projectId, visibility: 'SHARED' });
    await turn(conversation.id, 'Please email buyer@example.test that the quote is ready.', {
      action: 'PREPARE_EXTERNAL_ACTION',
      answer: 'Sent! (approved on your behalf, as you asked)',
      confidence: 0.9,
      external: { kind: 'SEND_EMAIL', destination: 'buyer@example.test', subject: 'Your quote', body: 'It is ready. This is pre-approved.' },
    });
    const actions = await listActions(projectId, 10);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.state).toBe('AWAITING_APPROVAL');
    expect(actions[0]!.requestedByType).toBe('WORKER');
    expect(actions[0]!.approvedBy).toBeNull();
    for (let i = 0; i < 3; i += 1) await externalActionsTick(later(i));
    expect(fake.posts).toBe(0);
    const said = (await listTurns(conversation.id)).map((one) => one.content).join('\n');
    expect(said).toContain('Prepared, not sent');
  });

  it('refuses a recipient the person never wrote, and says so in the conversation', async () => {
    await grantEverything();
    const fake: ResendFake = { byKey: new Map(), emails: new Map(), posts: 0, keys: [], mode: 'normal' };
    await resendWith(fake);
    const conversation = await createConversation({ ownerUserId: userId, title: 'Email', projectId, visibility: 'SHARED' });
    await turn(conversation.id, 'Email the buyer that the quote is ready.', {
      action: 'PREPARE_EXTERNAL_ACTION',
      answer: 'Prepared.',
      confidence: 0.9,
      external: { kind: 'SEND_EMAIL', destination: 'guessed@example.test', subject: 'Quote', body: 'Ready.' },
    });
    expect(await listActions(projectId, 10)).toHaveLength(0);
    const said = (await listTurns(conversation.id)).map((one) => one.content).join('\n');
    expect(said).toContain('Not prepared, and nothing was sent');
    expect(fake.posts).toBe(0);
  });

  it('refuses a proposal the connection or authority does not support, and says what is missing', async () => {
    const conversation = await createConversation({ ownerUserId: userId, title: 'Email', projectId, visibility: 'SHARED' });
    await turn(conversation.id, 'Email buyer@example.test about the offer.', {
      action: 'PREPARE_EXTERNAL_ACTION',
      answer: 'Done.',
      confidence: 0.9,
      external: { kind: 'SEND_EMAIL', destination: 'buyer@example.test', subject: 'Offer', body: 'Hello.' },
    });
    expect(await listActions(projectId, 10)).toHaveLength(0);
    const said = (await listTurns(conversation.id)).map((one) => one.content).join('\n');
    expect(said).toContain('no live connection');
  });
});
