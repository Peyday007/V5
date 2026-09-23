/**
 * External actions (§51): what a capability reading may claim, what an action
 * may do without a person, and what Brain says happened.
 *
 * Only the network edge is scripted. Everything between — the connection
 * reading, the commercial authority, Step 6's operation rows, the read-back
 * and the return into the conversation and the opening — is the real code
 * over the real database. The scripted provider is deliberately hostile: it
 * rate-limits, times out after accepting, and answers the send while the
 * read-back says something different, because those are the cases the path
 * exists for.
 *
 * A live receipt from a real provider is not something this file can give,
 * and it does not pretend to: that is `npm run external:prove`, run against a
 * real account, and recorded in docs/EXTERNAL-ACTIONS.md.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import { readCapability } from '../server/services/cash/capabilities.ts';
import { createConversation, listTurns } from '../server/repos/russellConversations.ts';
import { getDb } from '../server/db/database.ts';
import { setProviderFetch } from '../server/services/external/http.ts';
import { checkConnection, connect, readConnection, reconnect, revoke, secretNameFor } from '../server/services/external/connections.ts';
import {
  approveAction,
  cancelAction,
  executeAction,
  externalActionsTick,
  notifyWaitingDecisions,
  prepareAction,
  readBack,
  resolveUncertain,
} from '../server/services/external/actions.ts';
import { getAction, getConnection } from '../server/repos/externalActions.ts';
import { validateProposal } from '../server/services/russell/proposal.ts';

let projectId = '';
let userId = '';
const envNames: string[] = [];

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
let handler: Handler = () => new Response('{}', { status: 500 });
const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }> = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `external-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  calls.length = 0;
  setProviderFetch((async (url: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers ?? {}).entries());
    calls.push({ url: String(url), method: init?.method ?? 'GET', headers, body: String(init?.body ?? '') });
    return await handler(String(url), init ?? {});
  }) as typeof fetch);
});

afterEach(() => {
  setProviderFetch(null);
  for (const name of envNames.splice(0)) delete process.env[name];
});

function deploy(name: string, value: string): void {
  process.env[name] = value;
  envNames.push(name);
}

const TOPIC = 'brain-owner-topic-0123456789';

async function ntfyConnected() {
  const { connection } = await connect({ projectId, provider: 'NTFY', actorRef: userId });
  deploy(connection.secretName, TOPIC);
  handler = (url) => (url.endsWith('/v1/health') ? json({ healthy: true }) : json({}, 404));
  await checkConnection(connection.id, userId);
  return connection;
}

describe('a capability is a reading of a real connection', () => {
  it('stays MISSING through every stage short of the provider answering for the deployed credential', async () => {
    const read = async () => (await readCapability('NOTIFY_OWNER', projectId)).state;
    expect(await read()).toBe('MISSING');

    const { connection } = await connect({ projectId, provider: 'NTFY', actorRef: userId });
    // A row is not a capability.
    expect(await read()).toBe('MISSING');
    expect((await readConnection(connection)).state).toBe('WAITING_FOR_SECRET');

    // A secret entered is not a capability either.
    deploy(connection.secretName, TOPIC);
    expect((await readConnection(connection)).state).toBe('NOT_CHECKED');
    expect(await read()).toBe('MISSING');

    // The provider refusing is recorded, and still not present.
    handler = () => json({ healthy: false });
    await checkConnection(connection.id, userId);
    expect((await readConnection(connection)).state).toBe('UNHEALTHY');
    expect(await read()).toBe('MISSING');

    handler = () => json({ healthy: true });
    await checkConnection(connection.id, userId);
    expect(await read()).toBe('PRESENT');

    // Rotating the credential invalidates the reading until it is checked again.
    deploy(connection.secretName, TOPIC + 'x');
    expect((await readConnection(connection)).state).toBe('CREDENTIAL_CHANGED');
    expect(await read()).toBe('MISSING');
  });

  it('reads MISSING when nobody named a project, rather than borrowing another project’s connection', async () => {
    await ntfyConnected();
    expect((await readCapability('NOTIFY_OWNER', projectId)).state).toBe('PRESENT');
    expect((await readCapability('NOTIFY_OWNER')).state).toBe('UNKNOWN');
  });

  it('stores no credential anywhere a row can reach', async () => {
    const connection = await ntfyConnected();
    const tables = ['external_connections', 'external_health_checks', 'external_action_events'];
    for (const table of tables) {
      const rows = await getDb().all<Record<string, unknown>>(`SELECT * FROM ${table}`);
      expect(JSON.stringify(rows)).not.toContain(TOPIC);
    }
    expect(connection.secretName).toBe(secretNameFor(projectId, 'NTFY'));
  });

  it('never makes invoicing present from a test-mode key, and says so', async () => {
    const { connection } = await connect({ projectId, provider: 'STRIPE', selfDestination: 'owner@example.test', actorRef: userId });
    deploy(connection.secretName, 'sk_test_abcdefghijklmnop');
    handler = () => json({ livemode: false, object: 'balance' });
    await checkConnection(connection.id, userId);
    const reading = await readCapability('ISSUE_AN_INVOICE', projectId);
    expect(reading.state).toBe('MISSING');
    expect(reading.detail).toContain('TEST_ONLY');
  });

  it('keeps publishing and signing unavailable by policy, whatever is connected', async () => {
    for (const id of ['PUBLISH_A_LISTING', 'SIGN_AN_AGREEMENT']) {
      const reading = await readCapability(id, projectId);
      expect(reading.state).toBe('MISSING');
      expect(reading.definition?.requires).toContain('ALWAYS_PROHIBITED_COMMERCIAL');
    }
  });

  it('revoking stops the capability at once, and reconnecting needs a fresh check', async () => {
    const connection = await ntfyConnected();
    expect((await readCapability('NOTIFY_OWNER', projectId)).state).toBe('PRESENT');
    expect(await revoke({ connectionId: connection.id, actorRef: userId, reason: 'phone lost' })).toBe(true);
    expect((await readCapability('NOTIFY_OWNER', projectId)).state).toBe('MISSING');

    const again = await reconnect({ connectionId: connection.id, actorRef: userId });
    expect(again?.created).toBe(true);
    expect((await readCapability('NOTIFY_OWNER', projectId)).state).toBe('MISSING');
    await checkConnection(again!.connection.id, userId);
    expect((await readCapability('NOTIFY_OWNER', projectId)).state).toBe('PRESENT');
  });
});

describe('sending, receipts and read-back', () => {
  it('sends a self-directed notification once, keeps the receipt, and reads it back from the provider', async () => {
    await ntfyConnected();
    const conversation = await createConversation({ ownerUserId: userId, title: 'Test', projectId });
    let published = 0;
    handler = (url, init) => {
      if (init.method === 'POST') {
        published += 1;
        const body = JSON.parse(String(init.body)) as { tags: string[] };
        return json({ id: 'ntfy-msg-1', time: 1_700_000_000, event: 'message', topic: TOPIC, tags: body.tags });
      }
      if (url.includes('/json?poll=1')) {
        return new Response(JSON.stringify({ id: 'ntfy-msg-1', time: 1_700_000_000, event: 'message' }) + '\n');
      }
      return json({ healthy: true });
    };
    const prepared = await prepareAction({
      projectId,
      kind: 'NOTIFY_OWNER',
      content: { subject: 'Hello', body: 'A test to your own phone.' },
      conversationId: conversation.id,
      requestedByType: 'HUMAN',
      requestedBy: userId,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.action.state).toBe('APPROVED');

    const report = await executeAction(prepared.action.id);
    expect(report.state).toBe('CONFIRMED');
    const done = (await getAction(prepared.action.id))!;
    expect(done.providerRef).toBe('ntfy-msg-1');
    expect(done.readbackState).toBe('PUBLISHED');
    expect(done.operationId).not.toBeNull();

    // A second execution is not a second send.
    await executeAction(prepared.action.id);
    await externalActionsTick();
    expect(published).toBe(1);

    // The topic never travels in a URL on the send path.
    const send = calls.find((one) => one.method === 'POST')!;
    expect(send.url).not.toContain(TOPIC);

    // And the result is back in the conversation it came from.
    const turns = await listTurns(conversation.id);
    expect(JSON.stringify(turns)).toContain('ntfy-msg-1');
  });

  it('asks rather than resends after an ambiguous send, and stops at UNCERTAIN when the provider cannot say', async () => {
    await ntfyConnected();
    let published = 0;
    handler = (url, init) => {
      if (init.method === 'POST') {
        published += 1;
        throw new TypeError('socket hang up');
      }
      if (url.includes('/json?poll=1')) return new Response('', { status: 503 });
      return json({ healthy: true });
    };
    const prepared = await prepareAction({ projectId, kind: 'NOTIFY_OWNER', content: { subject: 'Hi', body: 'x' }, requestedByType: 'HUMAN', requestedBy: userId });
    if (!prepared.ok) throw new Error(prepared.reason);
    const report = await executeAction(prepared.action.id);
    expect(report.state).toBe('UNCERTAIN');

    await externalActionsTick();
    await executeAction(prepared.action.id);
    expect(published).toBe(1);
    expect((await getAction(prepared.action.id))!.state).toBe('UNCERTAIN');

    // A person's "it happened" needs the provider's identifier, and is then read back.
    const refused = await resolveUncertain({ actionId: prepared.action.id, actorRef: userId, outcome: 'HAPPENED', note: 'I saw it' });
    expect(refused.ok).toBe(false);
    const resolved = await resolveUncertain({ actionId: prepared.action.id, actorRef: userId, outcome: 'DID_NOT_HAPPEN', note: 'Nothing arrived' });
    expect(resolved.ok).toBe(true);
    expect((await getAction(prepared.action.id))!.state).toBe('FAILED');
    expect(published).toBe(1);
  });

  it('finds an ambiguous send on the provider instead of sending it again', async () => {
    await ntfyConnected();
    let tag = '';
    handler = (url, init) => {
      if (init.method === 'POST') {
        tag = (JSON.parse(String(init.body)) as { tags: string[] }).tags[0]!;
        return new Response('upstream', { status: 502 });
      }
      if (url.includes('/json?poll=1')) {
        return new Response(JSON.stringify({ id: 'found-it', event: 'message', tags: [tag] }) + '\n');
      }
      return json({ healthy: true });
    };
    const prepared = await prepareAction({ projectId, kind: 'NOTIFY_OWNER', content: { subject: 'Hi', body: 'y' }, requestedByType: 'HUMAN', requestedBy: userId });
    if (!prepared.ok) throw new Error(prepared.reason);
    const report = await executeAction(prepared.action.id);
    expect(report.state).toBe('CONFIRMED');
    expect((await getAction(prepared.action.id))!.providerRef).toBe('found-it');
  });
});

describe('a third party is reached only with authority and a person’s approval', () => {
  async function emailConnected() {
    const { connection } = await connect({ projectId, provider: 'RESEND', sender: 'brain@owned.test', selfDestination: 'owner@owned.test', actorRef: userId });
    deploy(connection.secretName, 're_testkey_abcdefghij');
    handler = () => json({ data: [{ status: 'verified' }] });
    await checkConnection(connection.id, userId);
    return connection;
  }

  it('refuses to prepare an email to a buyer without a standing commercial authority, naming the remedy', async () => {
    await emailConnected();
    const refused = await prepareAction({ projectId, kind: 'SEND_EMAIL', destination: 'buyer@example.test', content: { subject: 'Offer', body: 'Hello' }, requestedByType: 'HUMAN', requestedBy: userId });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toContain('CONTACT_BUYER');
    expect(refused.need).toContain('commercial authority');
  });

  it('waits for approval, sends under one stable key through a rate limit, and reads delivery back', async () => {
    await emailConnected();
    await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash over the next few weeks.' });
    await createAuthority({
      projectId, ownerUserId: userId, createdByUserId: userId, name: 'grant',
      allowedActions: [...COMMERCIAL_ACTIONS], prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
      maxCommittedCents: 100_000, maxPerActionCents: 40_000, maxConcurrent: 3, currency: 'USD',
    });
    const keys: string[] = [];
    let sends = 0;
    handler = (url, init) => {
      if (init.method === 'POST' && url.endsWith('/emails')) {
        sends += 1;
        keys.push(new Headers(init.headers).get('idempotency-key') ?? '');
        return sends === 1 ? json({ name: 'rate_limit_exceeded' }, 429) : json({ id: 'email-123' });
      }
      if (url.endsWith('/emails/email-123')) return json({ id: 'email-123', last_event: 'delivered' });
      return json({ data: [{ status: 'verified' }] });
    };
    const prepared = await prepareAction({ projectId, kind: 'SEND_EMAIL', destination: 'buyer@example.test', content: { subject: 'Offer', body: 'Hello' }, requestedByType: 'HUMAN', requestedBy: userId });
    if (!prepared.ok) throw new Error(prepared.reason);
    expect(prepared.action.state).toBe('AWAITING_APPROVAL');
    expect(prepared.action.commercialAction).toBe('CONTACT_BUYER');

    // Nothing leaves while it waits.
    await externalActionsTick();
    expect(sends).toBe(0);

    const approved = await approveAction({ actionId: prepared.action.id, approverUserId: userId });
    expect(approved.ok).toBe(true);
    const first = await executeAction(prepared.action.id);
    expect(first.state).toBe('APPROVED'); // the rate limit is backpressure
    await getDb().run('UPDATE external_actions SET next_attempt_at = ? WHERE id = ?', [new Date(0).toISOString(), prepared.action.id]);
    const second = await executeAction(prepared.action.id);
    expect(second.state).toBe('CONFIRMED');
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    const done = (await getAction(prepared.action.id))!;
    expect(done.providerRef).toBe('email-123');
    expect(done.readbackState).toBe('DELIVERED');
  });

  it('stops a send whose grant was withdrawn after it was approved, and nothing leaves', async () => {
    await emailConnected();
    await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash over the next few weeks.' });
    const grant = await createAuthority({
      projectId, ownerUserId: userId, createdByUserId: userId, name: 'grant',
      allowedActions: [...COMMERCIAL_ACTIONS], prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
      maxCommittedCents: 100_000, maxPerActionCents: 40_000, maxConcurrent: 3, currency: 'USD',
    });
    let sends = 0;
    handler = (url, init) => {
      if (init.method === 'POST') sends += 1;
      return json({ data: [{ status: 'verified' }] });
    };
    const prepared = await prepareAction({ projectId, kind: 'SEND_EMAIL', destination: 'buyer@example.test', content: { subject: 'Offer', body: 'Hello' }, requestedByType: 'HUMAN', requestedBy: userId });
    if (!prepared.ok) throw new Error(prepared.reason);
    expect((await approveAction({ actionId: prepared.action.id, approverUserId: userId })).ok).toBe(true);
    await getDb().run("UPDATE cash_authorities SET state = 'REVOKED', revoked_at = ?, revoked_by_user_id = ?, revoked_reason = 'x' WHERE id = ?", [new Date().toISOString(), userId, grant.id]);
    const report = await executeAction(prepared.action.id);
    expect(report.state).toBe('FAILED');
    expect(sends).toBe(0);
  });

  it('lets a person cancel before sending, and not after', async () => {
    await emailConnected();
    const prepared = await prepareAction({ projectId, kind: 'SEND_EMAIL', destination: 'owner@owned.test', content: { subject: 'Self test', body: 'Hello me' }, requestedByType: 'HUMAN', requestedBy: userId });
    if (!prepared.ok) throw new Error(prepared.reason);
    // To the owner's own address: no commercial authority is needed, approval still is.
    expect(prepared.action.commercialAction).toBeNull();
    expect(prepared.action.state).toBe('AWAITING_APPROVAL');
    expect((await cancelAction({ actionId: prepared.action.id, actorRef: userId, reason: 'changed my mind' })).ok).toBe(true);
    expect((await approveAction({ actionId: prepared.action.id, approverUserId: userId })).ok).toBe(false);
  });
});

describe('an invoice: issued, paid and settled are three facts', () => {
  it('issues a test-mode invoice to the owner, keyed per step, and reads each stage back separately', async () => {
    const { connection } = await connect({ projectId, provider: 'STRIPE', selfDestination: 'owner@owned.test', actorRef: userId });
    deploy(connection.secretName, 'sk_test_abcdefghijklmnop');
    let invoiceStatus = 'open';
    let txnStatus = 'pending';
    const keys: string[] = [];
    handler = (url, init) => {
      const key = new Headers(init.headers).get('idempotency-key');
      if (key) keys.push(key);
      if (url.endsWith('/balance')) return json({ livemode: false });
      if (url.endsWith('/customers')) return json({ id: 'cus_1' });
      if (url.endsWith('/invoices')) return json({ id: 'in_1' });
      if (url.endsWith('/invoiceitems')) return json({ id: 'ii_1' });
      if (url.endsWith('/finalize')) return json({ id: 'in_1', status: 'open' });
      if (url.endsWith('/send')) return json({ id: 'in_1', status: 'open', number: 'A-0001', livemode: false });
      if (url.includes('/invoices/in_1?')) {
        return json({
          id: 'in_1', status: invoiceStatus, amount_due: 2500, amount_paid: invoiceStatus === 'paid' ? 2500 : 0, livemode: false,
          charge: invoiceStatus === 'paid' ? { balance_transaction: { id: 'txn_1', status: txnStatus } } : null,
        });
      }
      return json({}, 404);
    };
    await checkConnection(connection.id, userId);

    // A test key cannot invoice anybody but the connection's own address.
    const third = await prepareAction({ projectId, kind: 'ISSUE_INVOICE', destination: 'buyer@example.test', currency: 'usd', content: { lines: [{ description: 'Work', amountCents: 2500 }] }, requestedByType: 'HUMAN', requestedBy: userId });
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.reason).toContain('TEST mode');

    const prepared = await prepareAction({ projectId, kind: 'ISSUE_INVOICE', destination: 'owner@owned.test', currency: 'usd', content: { lines: [{ description: 'Proving the path', amountCents: 2500 }] }, requestedByType: 'HUMAN', requestedBy: userId });
    if (!prepared.ok) throw new Error(prepared.reason);
    expect(prepared.action.amountCents).toBe(2500);
    expect((await approveAction({ actionId: prepared.action.id, approverUserId: userId })).ok).toBe(true);
    expect((await executeAction(prepared.action.id)).state).toBe('CONFIRMED');
    expect((await getAction(prepared.action.id))!.readbackState).toBe('ISSUED');
    expect(new Set(keys).size).toBe(keys.length); // one key per step, none reused across steps

    invoiceStatus = 'paid';
    await readBack(prepared.action.id);
    const paid = (await getAction(prepared.action.id))!;
    expect(paid.readbackState).toBe('PAYMENT_MADE');
    expect(paid.readbackFinal).toBe(false);

    txnStatus = 'available';
    await readBack(prepared.action.id);
    const settled = (await getAction(prepared.action.id))!;
    expect(settled.readbackState).toBe('FUNDS_SETTLED');
    expect(settled.readbackFinal).toBe(true);
    // Test money is not money: nothing reached the ledger.
    const entries = await getDb().all('SELECT * FROM cash_money_entries WHERE project_id = ?', [projectId]);
    expect(entries).toHaveLength(0);
  });
});

describe('the owner is told what is waiting, once', () => {
  it('sends one notification per waiting approval however many ticks read it', async () => {
    await ntfyConnected();
    const { connection } = await connect({ projectId, provider: 'RESEND', sender: 'brain@owned.test', selfDestination: 'owner@owned.test', actorRef: userId });
    deploy(connection.secretName, 're_testkey_abcdefghij');
    let pushes = 0;
    handler = (url, init) => {
      if (init.method === 'POST') {
        pushes += 1;
        return json({ id: `m${pushes}`, event: 'message' });
      }
      if (url.includes('/json?poll=1')) return new Response('');
      if (url.includes('/domains')) return json({ data: [{ status: 'verified' }] });
      return json({ healthy: true });
    };
    await checkConnection(connection.id, userId);
    const prepared = await prepareAction({ projectId, kind: 'SEND_EMAIL', destination: 'owner@owned.test', content: { subject: 'x', body: 'y' }, requestedByType: 'HUMAN', requestedBy: userId });
    expect(prepared.ok).toBe(true);
    expect(await notifyWaitingDecisions(projectId)).toBe(1);
    expect(await notifyWaitingDecisions(projectId)).toBe(0);
    await externalActionsTick();
    await externalActionsTick();
    expect(pushes).toBe(1);
  });
});

describe('Russell may propose, and never with fields it was not given', () => {
  it('accepts a well-formed external proposal and refuses an extra field inside it', async () => {
    const principal = { type: 'HUMAN', id: userId, memberships: [], isBrainAdmin: true } as never;
    const ok = validateProposal({
      principal,
      raw: { action: 'PREPARE_EXTERNAL_ACTION', answer: 'Prepared.', external: { kind: 'SEND_EMAIL', destination: 'a@b.test', subject: 's', body: 'b' } },
    });
    expect(ok.ok).toBe(true);
    const extra = validateProposal({
      principal,
      raw: { action: 'PREPARE_EXTERNAL_ACTION', answer: 'x', external: { kind: 'SEND_EMAIL', destination: 'a@b.test', subject: 's', body: 'b', approved: true } },
    });
    expect(extra.ok).toBe(false);
    const invoice = validateProposal({
      principal,
      raw: { action: 'PREPARE_EXTERNAL_ACTION', answer: 'x', external: { kind: 'ISSUE_INVOICE', subject: 's', body: 'b' } },
    });
    expect(invoice.ok).toBe(false);
  });
});

void getConnection;
