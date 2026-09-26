/**
 * Work done through people, seen from the two surfaces a person actually reads:
 * the assignee's own card on Home, and the line Russell says in the briefing.
 *
 * `humanWork.test.ts` walks the routes and the services. It cannot see either
 * of these, because one is a React component and the other is a projection no
 * route test reads. `cashBrowserToDatabase.test.ts` records why that seam needs
 * its own file: a component suite over a scripted `fetch` and a service suite
 * with no screen both pass for a control that posts a field the route does not
 * take. So the card here is the real component, over the real route, over the
 * real database, and the rows are checked after each press rather than what
 * the screen said.
 *
 * The assignee holds **no membership** on the project, exactly as in
 * production: an assignment reaches a person through their own page, never by
 * granting them the project.
 *
 * The jsdom-by-hand construction, the `.ts` extension and the dynamic imports
 * are all for `cashBrowserToDatabase`'s reasons; see its opening comment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import express from 'express';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { freshProject } from './helpers.ts';
import { createUser, grantMembership } from '../server/repos/identity.ts';
import { answerHumanRequest, getHumanRequest, markResumed } from '../server/repos/russellMissions.ts';
import { reopenAnswered, resumeAnsweredRequest } from '../server/services/russell/needsHuman.ts';
import { connectClaudeCapacity } from '../server/services/humanwork/recipes.ts';
import { getEngagement, listHumanWorkEvents } from '../server/repos/humanWork.ts';
import { humanWorkRouter } from '../server/routes/humanWork.ts';
import { briefing } from '../server/services/russell/projections.ts';
import { attachContext, newRequestId } from '../server/services/identity/context.ts';
import type { Principal, ProjectMembership } from '../server/domain/types.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://127.0.0.1/',
  pretendToBeVisual: true,
});
for (const key of [
  'window',
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'MouseEvent',
  'KeyboardEvent',
  'CustomEvent',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'MutationObserver',
  'DOMParser',
] as const) {
  Object.defineProperty(globalThis, key, {
    value: (dom.window as unknown as Record<string, unknown>)[key],
    configurable: true,
    writable: true,
  });
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react');
const { act, createElement } = await import('react');
const { MyAssignments } = await import('../client/src/russell/HumanWork.tsx');

let projectId = '';
let projectName = '';
let ownerId = '';
let assigneeId = '';
let speakingAs = '';
let server: Server | null = null;
const realFetch = globalThis.fetch;

function principal(): Principal {
  const isOwner = speakingAs === ownerId;
  return {
    type: 'HUMAN',
    id: speakingAs,
    handle: isOwner ? 'owner@example.test' : 'assignee@example.test',
    displayName: isOwner ? 'The owner' : 'The assignee',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: `ses_${speakingAs}`,
    authMethod: 'SESSION_COOKIE',
    memberships: isOwner
      ? [
          {
            id: 'mem',
            projectId,
            principalType: 'HUMAN',
            principalId: ownerId,
            role: 'ADMIN',
            scopes: ['project:read'],
            grantedByType: 'SYSTEM',
            grantedById: 'test',
            grantedAt: '2026-01-01T00:00:00.000Z',
            active: true,
          } as ProjectMembership,
        ]
      : [],
    requestId: 'req',
  } as Principal;
}

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  projectName = fixture.project.name;
  const tag = Math.random().toString(36).slice(2, 8);
  const owner = await createUser({
    email: `hw-owner-${tag}@example.test`,
    displayName: `Owner ${tag}`,
    password: 'correct horse battery staple',
  });
  ownerId = owner.id;
  await grantMembership({
    projectId,
    principalType: 'HUMAN',
    principalId: ownerId,
    role: 'ADMIN',
    scopes: ['project:read'],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });
  const assignee = await createUser({
    email: `hw-assignee-${tag}@example.test`,
    displayName: `Assignee ${tag}`,
    password: 'correct horse battery staple',
  });
  assigneeId = assignee.id;
  speakingAs = assigneeId;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    attachContext(req, {
      principal: principal(),
      requestId: newRequestId(),
      method: req.method,
      path: req.path,
      remoteAddr: null,
      userAgent: null,
    });
    next();
  });
  app.use('/api', humanWorkRouter);
  app.use((error: any, _req: any, res: any, _next: any) => {
    res
      .status(typeof error?.status === 'number' ? error.status : 500)
      .json({ error: String(error?.message ?? error) });
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    return await realFetch(url.startsWith('/') ? `http://127.0.0.1:${port}${url}` : url, init);
  });
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

/** The recipe, then an administrator's approval through Needs You. */
async function assignedAndApproved(): Promise<{ orderId: string; engagementId: string }> {
  const started = await connectClaudeCapacity({ projectId, memberUserId: assigneeId, actorRef: ownerId });
  if (!started.ok) throw new Error(started.reason);
  // Idempotent: a second call raises no second card, so read the one on the engagement.
  const requestId = started.value.decision?.id ?? started.value.engagement!.decisionRequestId!;
  const answered = await answerHumanRequest({ requestId, actorUserId: ownerId, choice: 'APPROVE_ENGAGEMENT' });
  expect(answered.ok).toBe(true);
  const request = (await getHumanRequest(requestId))!;
  const outcome = await resumeAnsweredRequest(request);
  if (!outcome.settled) await reopenAnswered(request, outcome.reason);
  else await markResumed(request.id);
  expect(outcome.settled).toBe(true);
  return { orderId: started.value.order.id, engagementId: started.value.engagement!.id };
}

describe('the assignee’s Home card, over the real route', () => {
  it('shows nothing before a decision, then the assignment, and the press reaches the rows', async () => {
    // Before anybody decides, the card renders nothing at all.
    const recipe = await connectClaudeCapacity({ projectId, memberUserId: assigneeId, actorRef: ownerId });
    if (!recipe.ok) throw new Error(recipe.reason);
    await act(async () => {
      render(createElement(MyAssignments));
    });
    expect(screen.queryByText('Your assignments')).toBeNull();
    cleanup();

    const { engagementId } = await assignedAndApproved();
    expect((await getEngagement(engagementId))!.state).toBe('INVITED');

    await act(async () => {
      render(createElement(MyAssignments));
    });
    await waitFor(() => expect(screen.getByText('Your assignments')).toBeTruthy());
    expect(screen.getByText(recipe.value.order.title)).toBeTruthy();
    expect(screen.getByText(/Compensation:/).textContent).toMatch(/no charge|\$0/i);

    // Accepting is the person's own act, and it is what makes them engaged.
    await act(async () => {
      fireEvent.click(screen.getByText('Accept this assignment'));
    });
    await waitFor(async () => expect((await getEngagement(engagementId))!.state).toBe('ENGAGED'));
    expect((await getEngagement(engagementId))!.engagedEvidence).toBe('ACCEPTED_IN_BRAIN');

    // The card reloads into the working state; a progress report is a row.
    await waitFor(() => expect(screen.getByText('Report progress')).toBeTruthy());
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Tell the coordinator something'), {
        target: { value: 'Opened the connection page' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Report progress'));
    });
    await waitFor(async () => {
      const kinds = (await listHumanWorkEvents(recipe.value.order.id)).map((one) => one.kind);
      expect(kinds).toContain('MILESTONE');
    });
  });

  it('shows another person nothing, even when that person holds the project', async () => {
    await assignedAndApproved();
    speakingAs = ownerId;
    await act(async () => {
      render(createElement(MyAssignments));
    });
    // Give the request time to land, then assert the absence.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(screen.queryByText('Your assignments')).toBeNull();
  });
});

describe('where the card is mounted', () => {
  it('is in Home above every branch, including the ones a person with no project reaches', () => {
    /*
     * The component test above renders the card directly, so it cannot see
     * Home dropping it. An assignee holds no membership, so the branches they
     * actually reach are the empty and the refused ones — which is why the
     * card sits in the fragment every branch renders rather than in the one a
     * project member sees.
     */
    const home = readFileSync(new URL('../client/src/russell/Home.tsx', import.meta.url), 'utf8');
    const fragment = /const connection = \(([\s\S]*?)\n  \);/.exec(home)?.[1] ?? '';
    expect(fragment).toMatch(/<MyAssignments \/>/);
    const view = home.slice(home.indexOf('const connection = ('), home.indexOf('const view = home.data.home;') + 200);
    expect(view.match(/\{connection\}/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });
});

describe('what Russell says about it', () => {
  it('puts one line per open piece of human work in the briefing, from the same derivation', async () => {
    const before = await briefing({ projectId, projectName });
    expect(before.peopleWorking).toEqual([]);

    await assignedAndApproved();
    const after = await briefing({ projectId, projectName });
    expect(after.peopleWorking).toHaveLength(1);
    const line = after.peopleWorking[0]!;
    // Who is doing what, what it costs, and whether it meets the need.
    expect(line).toMatch(/Connect/);
    expect(line).toMatch(/no charge|\$0/i);
  });
});
