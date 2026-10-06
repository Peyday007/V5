/**
 * Integration 3 — the product readings the surfaces are built on.
 *
 * Every screen added or rebuilt in Integration 3 renders a sentence or a kind
 * the server composed, so the decisions are asserted here, where they are
 * made: which kind a research packet is in, which connection word a surface
 * gets (and that only token rows can make one ask for a reconnect), which
 * category a person's step belongs to, how a plan rewrite is said in English,
 * what Home's money line may say, what the Needs You inbox holds and — the
 * half that matters as much — what it never holds.
 *
 * The infrastructure rule is asserted at the door: a database that did not
 * answer inside a route handler is a retryable 503 in plain words, never a 500
 * carrying the driver's text and never anything that reads as authorization.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { freshProject, type TestProject } from './helpers.ts';
import { classifyPacket, researchHeadline, researchOverview, PACKET_KINDS } from '../server/services/research/overview.ts';
import { surfaceConnectionState } from '../server/services/fleet/capacity.ts';
import { categoryOfCashReview, categoryOfJourneyStep, inboxFor } from '../server/services/russell/inbox.ts';
import { describeRewrite } from '../server/services/factory/story.ts';
import { suggestedExpiry } from '../server/services/russell/authority.ts';
import { BRAIN_TEMPORARILY_UNAVAILABLE, errorMiddleware, handler } from '../server/routes/helpers.ts';
import { createRun } from '../server/repos/runs.ts';
import { createOrchestration, updateOrchestration } from '../server/repos/research.ts';
import { createResearchGoal } from '../server/repos/russellAuthority.ts';
import { createUser } from '../server/repos/identity.ts';
import { getDb } from '../server/db/database.ts';
import type { OrchestrationStatus, Principal } from '../server/domain/types.ts';

describe('a research packet is in exactly one of six kinds', () => {
  const kind = (status: OrchestrationStatus, openDecision = false) =>
    classifyPacket({ status, openDecision, failureReason: 'why', cancelReason: null, repairReason: null, verdict: null });

  it('places every status, and never shows a person the raw status', () => {
    const expected: Record<string, string> = {
      QUEUED: 'WAITING',
      PLANNING: 'RUNNING',
      RESEARCHING: 'RUNNING',
      SYNTHESIZING: 'RUNNING',
      AUDITING: 'RUNNING',
      AWAITING_REPAIR: 'WAITING',
      PAUSED_QUOTA: 'WAITING',
      INTERRUPTED: 'RETRYING',
      AWAITING_APPROVAL: 'NEEDS_YOU',
      COMPLETE: 'DONE',
      COMPLETE_WITH_GAPS: 'DONE',
      FAILED: 'STOPPED',
      CANCELLED: 'STOPPED',
    };
    for (const [status, want] of Object.entries(expected)) {
      const placed = kind(status as OrchestrationStatus);
      expect(placed.kind, status).toBe(want);
      expect(PACKET_KINDS).toContain(placed.kind);
      expect(placed.phase).not.toMatch(/[A-Z]{2,}_[A-Z]/);
    }
  });

  it('calls a stopped packet "needs you" only when somebody is actually being asked', () => {
    expect(kind('NEEDS_HUMAN', true).kind).toBe('NEEDS_YOU');
    // No open card: it stopped, and saying it needs you would send a person to
    // an inbox with nothing in it.
    expect(kind('NEEDS_HUMAN', false).kind).toBe('STOPPED');
  });

  it('distinguishes waiting automatically, retrying, needing a person and refused', () => {
    const kinds = new Set([kind('QUEUED').kind, kind('INTERRUPTED').kind, kind('AWAITING_APPROVAL').kind, kind('FAILED').kind]);
    expect(kinds.size).toBe(4);
  });

  it('says what is happening rather than counting nothing', () => {
    const zero = Object.fromEntries(PACKET_KINDS.map((k) => [k, 0])) as Record<(typeof PACKET_KINDS)[number], number>;
    expect(researchHeadline(zero, 0)).toMatch(/not researching anything/);
    expect(researchHeadline({ ...zero, RUNNING: 2, NEEDS_YOU: 1, DONE: 3 }, 1)).toBe(
      '2 being researched now, 1 waiting on you, 3 finished.',
    );
  });
});

describe('a surface gets one connection word, and only token rows ask for a reconnect', () => {
  const base = {
    routineState: 'ENABLED',
    accountState: 'ENABLED',
    workerActive: true,
    connectorAuthState: 'HEALTHY' as string | null,
    secretPresent: true,
    rateLimited: false,
    proven: true,
  };

  it('reads healthy, retrying, quarantined, disabled and setting up apart', () => {
    expect(surfaceConnectionState(base)).toBe('HEALTHY');
    expect(surfaceConnectionState({ ...base, rateLimited: true })).toBe('RETRYING');
    expect(surfaceConnectionState({ ...base, connectorAuthState: 'REFRESH_RECOVERABLE' })).toBe('RETRYING');
    expect(surfaceConnectionState({ ...base, routineState: 'QUARANTINED' })).toBe('QUARANTINED');
    expect(surfaceConnectionState({ ...base, routineState: 'PAUSED' })).toBe('DISABLED');
    expect(surfaceConnectionState({ ...base, workerActive: false })).toBe('DISABLED');
    expect(surfaceConnectionState({ ...base, secretPresent: false })).toBe('SETTING_UP');
    expect(surfaceConnectionState({ ...base, proven: false })).toBe('SETTING_UP');
  });

  it('asks for a reconnect only when the connector’s own health says authorization is gone', () => {
    expect(surfaceConnectionState({ ...base, connectorAuthState: 'HUMAN_REAUTH_REQUIRED' })).toBe('REAUTH_REQUIRED');
    // Unknown health — a read that did not happen — is never a reconnect.
    for (const state of [null, 'UNKNOWN', 'HEALTHY', 'REFRESH_RECOVERABLE', 'DISABLED']) {
      expect(surfaceConnectionState({ ...base, connectorAuthState: state })).not.toBe('REAUTH_REQUIRED');
    }
  });
});

describe('the inbox groups a person’s steps by kind, never by reading the sentence', () => {
  it('puts each commercial step where a person looks for it', () => {
    expect(categoryOfJourneyStep('AGREEMENT')).toBe('BUYER');
    expect(categoryOfJourneyStep('INVOICE_TERMS')).toBe('INVOICE');
    expect(categoryOfJourneyStep('PAYMENT_UNKNOWN')).toBe('FINANCIAL');
    expect(categoryOfJourneyStep('FULFIL')).toBe('OTHER');
    expect(categoryOfCashReview('AUTHORITY')).toBe('AUTHORITY');
    expect(categoryOfCashReview('SHORTFALL')).toBe('BUDGET');
    expect(categoryOfCashReview('CHOOSE_BETWEEN_QUALIFIED')).toBe('JUDGMENT');
  });
});

describe('a plan rewrite is said in English', () => {
  it('explains a merge as the plan not being able to finish', () => {
    const merged = describeRewrite({ action: 'MERGE_UNITS', from: 'Write the test', to: 'Add the endpoint', paths: ['a.ts'] });
    expect(merged).toMatch(/^Brain merged “Write the test” into “Add the endpoint”, because the original plan could not finish/);
    const moved = describeRewrite({ action: 'MOVE_PATH', from: 'Tests', to: 'Feature', paths: ['x.test.ts'] });
    expect(moved).toMatch(/moved x\.test\.ts from “Tests” to “Feature”/);
    expect(merged + moved).not.toMatch(/MERGE_UNITS|MOVE_PATH/);
  });
});

describe('the standing-permission proposal can always be approved', () => {
  it('proposes an expiry in the future, stable within a month', () => {
    // The old constant became the past on 2026-10-06 and Approve began failing.
    expect(suggestedExpiry('2026-10-06T12:00:00.000Z')).toBe('2027-01-01T00:00:00.000Z');
    expect(suggestedExpiry('2026-10-31T23:59:59.000Z')).toBe('2027-01-01T00:00:00.000Z');
    expect(suggestedExpiry('2026-11-01T00:00:00.000Z')).toBe('2027-02-01T00:00:00.000Z');
    expect(Date.parse(suggestedExpiry(new Date().toISOString()))).toBeGreaterThan(Date.now());
  });
});

describe('a database that did not answer inside a handler is temporary, never authorization', () => {
  it('answers 503 with a retryable sentence and Retry-After', async () => {
    const app = express();
    app.get(
      '/boom',
      handler(async () => {
        const error = new Error('canceling statement due to statement timeout') as Error & { code: string };
        error.code = '57014';
        throw error;
      }),
    );
    app.use(errorMiddleware);
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/boom`);
      const body = (await response.json()) as { error: string; retryable: boolean };
      expect(response.status).toBe(503);
      expect(response.headers.get('retry-after')).toBe('5');
      expect(body).toEqual({ error: BRAIN_TEMPORARILY_UNAVAILABLE, retryable: true });
      expect(body.error).not.toMatch(/authori|reconnect|sign in|statement timeout/i);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('the research overview and the inbox, over real rows', () => {
  let fixture: TestProject;
  let userId = '';
  let principal: Principal;

  beforeEach(async () => {
    fixture = await freshProject();
    userId = (
      await createUser({
        email: `i3-${Math.random().toString(36).slice(2, 10)}@example.test`,
        displayName: 'The owner',
        password: 'correct horse battery staple',
      })
    ).id;
    principal = {
      type: 'HUMAN',
      id: userId,
      handle: 'owner@example.test',
      displayName: 'The owner',
      isBrainAdmin: false,
      mustChangePassword: false,
      credentialId: 'ses',
      authMethod: 'SESSION_COOKIE',
      memberships: [
        {
          id: 'mem',
          projectId: fixture.project.id,
          principalType: 'HUMAN',
          principalId: userId,
          role: 'ADMIN',
          scopes: ['project:read'],
          grantedByType: 'SYSTEM',
          grantedById: 'test',
          grantedAt: '2026-01-01T00:00:00.000Z',
          active: true,
        },
      ],
      requestId: 'req',
    } as Principal;
  });

  async function packet(title: string, goal?: { goalId: string; packetKey: string }) {
    const layer = fixture.layers[0]!;
    const run = await createRun({
      projectId: fixture.project.id,
      layerId: layer.id,
      runType: 'FOUNDATION',
      status: 'PLANNED',
      provider: 'WORKER',
      prompt: title,
    });
    return createOrchestration({
      projectId: fixture.project.id,
      layerId: layer.id,
      runId: run.id,
      title,
      assignment: title,
      provider: 'WORKER',
      autoApprove: false,
      ...(goal ? { goal } : {}),
    });
  }

  it('reads goal → budget → packets, each packet in its kind, fixtures counted but hidden', async () => {
    const goal = await createResearchGoal({
      projectId: fixture.project.id,
      ownerUserId: userId,
      createdByUserId: userId,
      name: 'Who buys county records',
      maxPackets: 1,
      maxFragments: 5,
      deadline: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    const under = await packet('Which counties sell their rolls', { goalId: goal.id, packetKey: 'round-1' });
    await updateOrchestration(under.id, { status: 'RESEARCHING' });
    const loose = await packet('A question from a conversation');
    await updateOrchestration(loose.id, { status: 'INTERRUPTED' });
    const fixtureRow = await packet('A fixture');
    await getDb().run('UPDATE research_orchestrations SET fixture = 1 WHERE id = ?', [fixtureRow.id]);

    const overview = await researchOverview(fixture.project.id);
    expect(overview.goals).toHaveLength(1);
    expect(overview.goals[0]!.budget.name).toBe('Who buys county records');
    expect(overview.goals[0]!.packets.map((one) => [one.title, one.kind])).toEqual([
      ['Which counties sell their rolls', 'RUNNING'],
    ]);
    expect(overview.other.map((one) => [one.title, one.kind])).toEqual([['A question from a conversation', 'RETRYING']]);
    expect(overview.technicalHidden).toBe(1);
    expect(overview.headline).toBe('1 being researched now, 1 continuing by itself.');

    // The one packet the goal may run is spent, so the inbox names the ceiling.
    const inbox = await inboxFor({ principal, projectId: fixture.project.id, origin: 'http://localhost' });
    const budget = inbox.items.find((item) => item.category === 'BUDGET');
    expect(budget?.title).toMatch(/Who buys county records/);
    expect(budget?.action).toEqual({ type: 'OPEN', destination: 'RESEARCH', label: 'Open Research' });
  });

  it('asks for the standing permission when there is none, and holds nothing that is not a person’s', async () => {
    const inbox = await inboxFor({ principal, projectId: fixture.project.id, origin: 'http://localhost' });
    expect(inbox.items.map((item) => item.category)).toContain('AUTHORITY');
    expect(inbox.items.find((item) => item.action.type === 'GRANT_RESEARCH_AUTHORITY')).toBeTruthy();
    // No connection item for an account that never connected: a missing
    // connection is not a lapsed one, and nothing here asks for a reconnect.
    expect(inbox.items.some((item) => item.category === 'CONNECTION')).toBe(false);
    for (const item of inbox.items) {
      expect(item.reason.length).toBeGreaterThan(0);
      expect(item.ifIgnored.length).toBeGreaterThan(0);
      expect(item.requestedAction.length).toBeGreaterThan(0);
      expect(item.continuing.length).toBeGreaterThan(0);
    }
    expect(inbox.categories.map((one) => one.key)[0]).toBe('AUTHORITY');
  });
});
