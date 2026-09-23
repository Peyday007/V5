/**
 * Getting work done through people, walked end to end over HTTP.
 *
 * Four principals, because the boundaries are the point:
 *
 *   owner        an ADMIN of the project — opens work, decides, accepts
 *   coordinator  a MEMBER — finds people, prepares terms, reviews
 *   assignee     a person on this Brain with **no membership** at all — they
 *                see their assignment and nothing of the project
 *   outsider     somebody else, who must not be able to tell an assignment
 *                exists
 *
 * Only the answers a person gives are simulated; every transition is the real
 * route, the real policy module and the real repositories.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { freshProject } from './helpers.ts';
import { createUser, grantMembership } from '../server/repos/identity.ts';
import { answerHumanRequest, getHumanRequest, markResumed } from '../server/repos/russellMissions.ts';
import { reopenAnswered, resumeAnsweredRequest } from '../server/services/russell/needsHuman.ts';
import { declareTask, declareWorkflow } from '../server/services/labor/declare.ts';
import { assignByPerson } from '../server/services/labor/assign.ts';
import { getTask } from '../server/repos/labor.ts';
import { humanWorkRouter } from '../server/routes/humanWork.ts';
import { attachContext, newRequestId } from '../server/services/identity/context.ts';
import { runHumanWorkTick } from '../server/services/humanwork/kernel.ts';
import { reviewCondition } from '../server/services/humanwork/deliver.ts';
import { connectClaudeCapacity } from '../server/services/humanwork/recipes.ts';
import { orderView } from '../server/services/humanwork/view.ts';
import { getEngagement, getOrder, listOrders } from '../server/repos/humanWork.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import type { Principal, ProjectMembership, ProjectRole } from '../server/domain/types.ts';

interface Person {
  name: string;
  id: string;
  role: ProjectRole | null;
}

let projectId = '';
let owner: Person;
let coordinator: Person;
let assignee: Person;
let outsider: Person;
let speaking: Person;
let server: Server | null = null;
let port = 0;

function principalFor(person: Person): Principal {
  const memberships: ProjectMembership[] = person.role
    ? [
        {
          id: `mem_${person.name}`,
          projectId,
          principalType: 'HUMAN',
          principalId: person.id,
          role: person.role,
          scopes: ['project:read'],
          grantedByType: 'SYSTEM',
          grantedById: 'test',
          grantedAt: '2026-01-01T00:00:00.000Z',
          revokedAt: null,
          active: true,
        } as unknown as ProjectMembership,
      ]
    : [];
  return {
    type: 'HUMAN',
    id: person.id,
    handle: `${person.name}@example.test`,
    displayName: person.name,
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: `ses_${person.name}`,
    authMethod: 'SESSION_COOKIE',
    memberships,
    requestId: 'req',
  } as unknown as Principal;
}

async function as(person: Person, method: string, route: string, body?: unknown) {
  speaking = person;
  const response = await fetch(`http://127.0.0.1:${port}/api${route}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: response.status, body: parsed, text };
}

async function person(name: string, role: ProjectRole | null): Promise<Person> {
  const user = await createUser({
    email: `${name}-${Math.random().toString(36).slice(2, 8)}@example.test`,
    displayName: `${name} ${Math.random().toString(36).slice(2, 6)}`,
    password: 'correct horse battery staple',
  });
  if (role) {
    await grantMembership({
      projectId,
      principalType: 'HUMAN',
      principalId: user.id,
      role,
      scopes: ['project:read'],
      grantedByType: 'SYSTEM',
      grantedById: 'test',
    });
  }
  return { name, id: user.id, role };
}

/** A task the labor map says a person produces. */
async function humanTask(name = 'Authorize the connector'): Promise<string> {
  const workflow = await declareWorkflow({ projectId, name: `Capacity ${Math.random()}`, description: null, opportunityId: null, actorRef: owner.id });
  const declared = await declareTask({
    projectId,
    workflowId: workflow.workflow.id,
    name,
    output: 'A connector authorized in the account holder\'s own Claude account',
    capabilityId: null,
    actorRef: owner.id,
  });
  const task = (await getTask(declared!.task.id))!;
  const assigned = await assignByPerson({
    projectId,
    task,
    productionLayer: 'DOMESTIC_HUMAN',
    necessityReason: 'ACCOUNTABILITY_LICENSING',
    rationale: 'Only the holder of an account may authorize something inside it.',
    actorRef: owner.id,
  });
  expect(assigned.ok).toBe(true);
  return task.id;
}

/** Answer the card as somebody, then run exactly what the durable loop runs. */
async function answerCard(requestId: string, by: Person, choice: string) {
  const answered = await answerHumanRequest({ requestId, actorUserId: by.id, choice });
  expect(answered.ok).toBe(true);
  const request = (await getHumanRequest(requestId))!;
  const outcome = await resumeAnsweredRequest(request);
  if (!outcome.settled) await reopenAnswered(request, outcome.reason);
  else await markResumed(request.id);
  return outcome;
}

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  owner = await person('owner', 'ADMIN');
  coordinator = await person('coord', 'MEMBER');
  assignee = await person('assignee', null);
  outsider = await person('outsider', null);
  speaking = owner;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    attachContext(req, {
      principal: principalFor(speaking),
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
    res.status(typeof error?.status === 'number' ? error.status : 500).json({ error: String(error?.message ?? error) });
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = null;
});

const REVIEWED = [{ key: 'works', statement: 'The connector authorizes and a session arrives', check: 'PERSON_REVIEW' }];

function termsFor(cents = 0) {
  return {
    scope: 'Authorize the Brain connector in your own Claude account and bind your four Routines.',
    deliverables: ['An authorized connector', 'The four trigger references'],
    schedule: [{ milestone: 'Connector authorized', due: '2099-01-01' }],
    compensationCents: cents,
    currency: 'USD',
    compensationBasis: cents === 0 ? 'Internal team member; no charge' : 'The contractor quoted it',
    access: [],
    confidentiality: 'The connector link is a single-use credential and is not shared.',
    ownership: 'Not applicable: nothing is produced that could be owned.',
  };
}

async function openOrder(acceptance: unknown = REVIEWED) {
  const taskId = await humanTask();
  const opened = await as(owner, 'POST', `/projects/${projectId}/human-work/orders`, {
    taskId,
    title: 'Connect a Claude account',
    work: 'Authorize the connector inside the account and supply the trigger references.',
    brainPrepares: ['The four secret names are already deployed', 'The exact steps on the connection page'],
    deliverables: ['An authorized connector'],
    acceptance,
    sharedContext: ['Your connection page names each step.'],
  });
  expect(opened.status).toBe(200);
  return opened.body.order;
}

describe('step 1 — a person is necessary, and for exactly what', () => {
  it('refuses to open work nobody has said needs a person', async () => {
    const workflow = await declareWorkflow({ projectId, name: 'Unallocated', description: null, opportunityId: null, actorRef: owner.id });
    const task = await declareTask({ projectId, workflowId: workflow.workflow.id, name: 'Draft', output: 'A draft', capabilityId: null, actorRef: owner.id });
    const refused = await as(owner, 'POST', `/projects/${projectId}/human-work/orders`, {
      taskId: task!.task.id,
      title: 'x',
      work: 'y',
      deliverables: ['z'],
      acceptance: REVIEWED,
    });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatch(/Nothing has established that a person produces this task/);
  });

  it('refuses an order with no acceptance standard, and lets only an administrator open one', async () => {
    const taskId = await humanTask();
    const noStandard = await as(owner, 'POST', `/projects/${projectId}/human-work/orders`, {
      taskId, title: 'x', work: 'y', deliverables: ['z'], acceptance: [],
    });
    expect(noStandard.status).toBe(422);
    const byMember = await as(coordinator, 'POST', `/projects/${projectId}/human-work/orders`, {
      taskId, title: 'x', work: 'y', deliverables: ['z'], acceptance: REVIEWED,
    });
    expect(byMember.status).toBe(404);
  });
});

describe('steps 2 to 5 — the whole journey with a team member', () => {
  it('finds, decides, hands off, coordinates, repairs and accepts, keeping every boundary', async () => {
    const order = await openOrder();

    // Step 2. A researched possibility needs a claim; a team member needs an account.
    const invented = await as(coordinator, 'POST', `/projects/${projectId}/human-work/orders/${order.id}/candidates`, {
      relationship: 'RESEARCHED', displayName: 'Somebody on the internet',
    });
    expect(invented.status).toBe(422);
    const claimedSkill = await as(coordinator, 'POST', `/projects/${projectId}/human-work/orders/${order.id}/candidates`, {
      relationship: 'TEAM_MEMBER', userId: assignee.id,
      competence: [{ statement: 'Holds the Claude account', basis: 'BRAIN_RECORD', ref: 'deployment secrets present' }, { statement: 'Says they are fast', basis: 'CLAIMED_BY_CANDIDATE' }],
      availability: 'Evenings this week',
      quoteCents: 0, quoteSource: 'INTERNAL_NO_CHARGE',
    });
    expect(claimedSkill.status).toBe(200);
    const candidateId = claimedSkill.body.candidate.id;

    let view = await as(coordinator, 'GET', `/projects/${projectId}/human-work`);
    let one = view.body.orders[0];
    expect(one.stage).toBe('QUALIFYING');
    // A claimed skill is written down and never counted as proof.
    expect(one.candidates[0].qualification.evidenced).toBe(1);
    expect(one.candidates[0].qualification.claimedOnly).toBe(1);

    // Step 3. Terms that leave something out are refused; complete ones reach Needs You.
    const incomplete = await as(coordinator, 'POST', `/projects/${projectId}/human-work/orders/${order.id}/engagements`, {
      candidateId, terms: { ...termsFor(), confidentiality: '' },
    });
    expect(incomplete.status).toBe(422);
    const prepared = await as(coordinator, 'POST', `/projects/${projectId}/human-work/orders/${order.id}/engagements`, {
      candidateId, terms: termsFor(),
    });
    expect(prepared.status).toBe(200);
    const engagementId = prepared.body.engagement.id;
    const requestId = prepared.body.decisionRequestId;
    expect(requestId).toBeTruthy();
    const card = (await getHumanRequest(requestId))!;
    expect(card.authorityNeeded).toMatch(/no charge/);
    expect(card.recommendation).toMatch(/grants no access and pays nobody/);

    // The assignee sees nothing before a decision.
    expect((await as(assignee, 'GET', '/assignments')).body.assignments).toHaveLength(0);

    // A member answering the card cannot commit anybody: it comes back.
    const byMember = await answerCard(requestId, coordinator, 'APPROVE_ENGAGEMENT');
    expect(byMember.settled).toBe(false);
    expect((await getHumanRequest(requestId))!.state).toBe('OPEN');
    expect((await getEngagement(engagementId))!.state).toBe('PROPOSED');

    // The administrator approves; the ask reaches the team member in Brain.
    const approved = await answerCard(requestId, owner, 'APPROVE_ENGAGEMENT');
    expect(approved.settled).toBe(true);
    let engagement = (await getEngagement(engagementId))!;
    expect(engagement.state).toBe('INVITED');
    expect(engagement.funding).toBe('NO_CHARGE');
    expect(engagement.approvedByUserId).toBe(owner.id);

    view = await as(owner, 'GET', `/projects/${projectId}/human-work`);
    one = view.body.orders[0];
    expect(one.stage).toBe('AWAITING_ACCEPTANCE');
    expect(one.agreement).toMatch(/has not answered. An unanswered ask is not an agreement/);

    // Step 4. The assignee sees exactly their brief — no project, nothing more.
    const list = await as(assignee, 'GET', '/assignments');
    expect(list.body.assignments).toHaveLength(1);
    const brief = list.body.assignments[0];
    expect(brief.context).toEqual(['Your connection page names each step.']);
    expect(JSON.stringify(brief)).not.toContain(projectId);
    // Nobody else can tell it exists.
    const peek = await as(outsider, 'GET', `/assignments/${engagementId}`);
    const invented404 = await as(outsider, 'GET', '/assignments/hwe_doesnotexist');
    expect(peek.status).toBe(404);
    expect(peek.text).toBe(invented404.text);
    // Nor read the project.
    expect((await as(assignee, 'GET', `/projects/${projectId}/human-work`)).status).toBe(404);

    // Nothing can be reported on before they accept.
    const early = await as(assignee, 'POST', `/assignments/${engagementId}/updates`, { kind: 'MILESTONE', text: 'started' });
    expect(early.status).toBe(422);
    // Only they can accept; the coordinator cannot attest for a team member.
    const attest = await as(coordinator, 'POST', `/projects/${projectId}/human-work/engagements/${engagementId}/attest-acceptance`, { evidence: 'they said yes' });
    expect(attest.status).toBe(422);
    const accepted = await as(assignee, 'POST', `/assignments/${engagementId}/answer`, { accept: true });
    expect(accepted.status).toBe(200);
    engagement = (await getEngagement(engagementId))!;
    expect(engagement.state).toBe('ENGAGED');
    expect(engagement.engagedEvidence).toBe('ACCEPTED_IN_BRAIN');

    // Access is never the assignee's to record.
    expect((await as(assignee, 'POST', `/assignments/${engagementId}/updates`, { kind: 'ACCESS_GRANTED', text: 'I gave myself access' })).status).toBe(422);
    expect((await as(assignee, 'POST', `/assignments/${engagementId}/updates`, { kind: 'QUESTION', text: 'Which account?' })).status).toBe(200);
    expect((await as(coordinator, 'POST', `/projects/${projectId}/human-work/engagements/${engagementId}/updates`, { kind: 'ANSWER', text: 'Your own.' })).status).toBe(200);

    // Assigned is not delivered.
    expect((await as(owner, 'POST', `/projects/${projectId}/human-work/orders/${order.id}/accept`, {})).status).toBe(422);

    // Step 5. A sentence is not a deliverable; a reference is.
    expect((await as(assignee, 'POST', `/assignments/${engagementId}/deliverables`, { description: 'Done' })).status).toBe(400);
    expect((await as(assignee, 'POST', `/assignments/${engagementId}/deliverables`, { description: 'Done', reference: 'Connector "Brain (x)" authorized' })).status).toBe(200);

    // A NOT_MET needs its repair; the assignee cannot judge their own work.
    const selfReview = await reviewCondition({ engagementId, criterionKey: 'works', verdict: 'MET', note: 'I did it', reviewerUserId: assignee.id });
    expect(selfReview.ok).toBe(false);
    expect((await as(coordinator, 'POST', `/projects/${projectId}/human-work/engagements/${engagementId}/reviews`, { criterionKey: 'works', verdict: 'NOT_MET', note: 'No session arrived' })).status).toBe(422);
    expect((await as(coordinator, 'POST', `/projects/${projectId}/human-work/engagements/${engagementId}/reviews`, { criterionKey: 'works', verdict: 'NOT_MET', note: 'No session arrived', repair: 'Select the new connector in the Routine, not the old one' })).status).toBe(200);
    view = await as(owner, 'GET', `/projects/${projectId}/human-work`);
    expect(view.body.orders[0].stage).toBe('REPAIR_REQUESTED');
    expect(view.body.orders[0].nextAction.text).toMatch(/Select the new connector/);
    const briefAfter = (await as(assignee, 'GET', `/assignments/${engagementId}`)).body;
    expect(briefAfter.acceptance[0].repair).toMatch(/Select the new connector/);

    expect((await as(assignee, 'POST', `/assignments/${engagementId}/deliverables`, { description: 'Repaired', reference: 'Routine now selects the new connector' })).status).toBe(200);
    // The earlier NOT_MET belongs to round 1 and does not carry over.
    view = await as(owner, 'GET', `/projects/${projectId}/human-work`);
    expect(view.body.orders[0].stage).toBe('UNDER_REVIEW');
    expect((await as(coordinator, 'POST', `/projects/${projectId}/human-work/engagements/${engagementId}/reviews`, { criterionKey: 'works', verdict: 'MET', note: 'Session arrived and finished a bin' })).status).toBe(200);

    // Only an administrator accepts.
    expect((await as(coordinator, 'POST', `/projects/${projectId}/human-work/orders/${order.id}/accept`, {})).status).toBe(404);
    const done = await as(owner, 'POST', `/projects/${projectId}/human-work/orders/${order.id}/accept`, {});
    expect(done.status).toBe(200);
    expect(done.body.order.state).toBe('ACCEPTED');
    expect((await getEngagement(engagementId))!.state).toBe('COMPLETED');

    // Money: a no-charge engagement cannot be paid for without a new decision.
    const overpay = await as(owner, 'POST', `/projects/${projectId}/human-work/engagements/${engagementId}/costs`, { kind: 'PAID', amountCents: 100, reference: 'tx_1', idempotencyKey: 'pay-1' });
    expect(overpay.status).toBe(422);
    const hours = await as(owner, 'POST', `/projects/${projectId}/human-work/engagements/${engagementId}/costs`, { kind: 'INCURRED', amountCents: 0, hours: 0.5, idempotencyKey: 'time-1' });
    expect(hours.status).toBe(200);
    const again = await as(owner, 'POST', `/projects/${projectId}/human-work/engagements/${engagementId}/costs`, { kind: 'INCURRED', amountCents: 0, hours: 0.5, idempotencyKey: 'time-1' });
    expect(again.body.replayed).toBe(true);
    expect(again.body.obligations.hours).toBe(0.5);

    // Step 5's feedback: a later staffing decision sees how this went.
    const next = await openOrder();
    const again2 = await as(coordinator, 'POST', `/projects/${projectId}/human-work/orders/${next.id}/candidates`, { relationship: 'TEAM_MEMBER', userId: assignee.id });
    expect(again2.status).toBe(200);
    view = await as(owner, 'GET', `/projects/${projectId}/human-work`);
    const later = view.body.orders.find((row: any) => row.order.id === next.id);
    const reliability = later.candidates[0].qualification.reliability;
    expect(reliability.completed).toBe(1);
    expect(reliability.firstPass).toBe(0);
    expect(reliability.onTime).toBe(1);
  });
});

describe('outside the team, and money', () => {
  it('prepares the message but never pretends it was sent or answered', async () => {
    const order = await openOrder();
    const added = await as(owner, 'POST', `/projects/${projectId}/human-work/orders/${order.id}/candidates`, {
      relationship: 'EXISTING_RELATIONSHIP', displayName: 'Acme Freight', kind: 'ORGANIZATION',
      competence: [{ statement: 'Did our last move', basis: 'PERSON_ATTESTED', ref: 'owner' }],
      quoteCents: 50_000, quoteSource: 'CANDIDATE_QUOTED', contactChannel: 'email the owner holds',
    });
    const prepared = await as(owner, 'POST', `/projects/${projectId}/human-work/orders/${order.id}/engagements`, {
      candidateId: added.body.candidate.id, terms: termsFor(50_000),
    });
    const engagementId = prepared.body.engagement.id;
    // Nobody may be told before a decision.
    expect((await as(coordinator, 'POST', `/projects/${projectId}/human-work/engagements/${engagementId}/invitation-sent`, { channel: 'email' })).status).toBe(422);

    await answerCard(prepared.body.decisionRequestId, owner, 'APPROVE_ENGAGEMENT');
    const engagement = (await getEngagement(engagementId))!;
    expect(engagement.state).toBe('APPROVED');
    expect(engagement.funding).toBe('DIRECT_APPROVAL');
    expect(engagement.approvedMaxCents).toBe(50_000);

    const view = await as(owner, 'GET', `/projects/${projectId}/human-work`);
    const row = view.body.orders.find((one: any) => one.order.id === order.id);
    expect(row.stage).toBe('AUTHORIZED_NOT_SENT');
    expect(row.invitationDraft).toMatch(/USD 500\.00/);
    expect(row.blockers[0].statement).toMatch(/no outbound channel/);

    // The tick does not send it: Brain has no channel to them.
    await runHumanWorkTick();
    expect((await getEngagement(engagementId))!.state).toBe('APPROVED');

    expect((await as(coordinator, 'POST', `/projects/${projectId}/human-work/engagements/${engagementId}/invitation-sent`, { channel: 'email', reference: 'sent 10:02' })).status).toBe(200);
    expect((await as(coordinator, 'POST', `/projects/${projectId}/human-work/engagements/${engagementId}/attest-acceptance`, { evidence: '' })).status).toBe(400);
    expect((await as(coordinator, 'POST', `/projects/${projectId}/human-work/engagements/${engagementId}/attest-acceptance`, { evidence: 'Signed quote returned 10:40' })).status).toBe(200);
    const after = (await as(owner, 'GET', `/projects/${projectId}/human-work`)).body.orders.find((one: any) => one.order.id === order.id);
    expect(after.agreement).toMatch(/attested .* did not accept in Brain themselves/);

    // A payment without a reference, or above what was approved, is refused.
    expect((await as(owner, 'POST', `/projects/${projectId}/human-work/engagements/${engagementId}/costs`, { kind: 'PAID', amountCents: 20_000, idempotencyKey: 'p1' })).status).toBe(422);
    expect((await as(owner, 'POST', `/projects/${projectId}/human-work/engagements/${engagementId}/costs`, { kind: 'PAID', amountCents: 60_000, reference: 'tx', idempotencyKey: 'p2' })).status).toBe(422);
    const paid = await as(owner, 'POST', `/projects/${projectId}/human-work/engagements/${engagementId}/costs`, { kind: 'PAID', amountCents: 20_000, reference: 'tx_2', idempotencyKey: 'p3' });
    expect(paid.body.obligations.outstandingCents).toBe(30_000);
    // Cancelling keeps what is owed.
    expect((await as(owner, 'POST', `/projects/${projectId}/human-work/orders/${order.id}/cancel`, { reason: 'Moved on' })).status).toBe(200);
    expect((await getOrder(order.id))!.state).toBe('CANCELLED');
  });

  it('never bypasses a standing commercial authority that covers the action', async () => {
    await createAuthority({
      projectId,
      ownerUserId: owner.id,
      createdByUserId: owner.id,
      name: 'grant',
      allowedActions: [...COMMERCIAL_ACTIONS],
      prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
      maxCommittedCents: 500_000,
      maxPerActionCents: 100_000,
      maxConcurrent: 3,
      currency: 'USD',
    });
    const order = await openOrder();
    const added = await as(owner, 'POST', `/projects/${projectId}/human-work/orders/${order.id}/candidates`, {
      relationship: 'EXISTING_RELATIONSHIP', displayName: 'Bee Movers', quoteCents: 50_000, quoteSource: 'CANDIDATE_QUOTED',
    });
    const prepared = await as(owner, 'POST', `/projects/${projectId}/human-work/orders/${order.id}/engagements`, {
      candidateId: added.body.candidate.id, terms: termsFor(50_000),
    });
    // No capital has been recorded, so the grant's own ceilings refuse the hold,
    // and the approval is not carried out around it.
    const outcome = await answerCard(prepared.body.decisionRequestId, owner, 'APPROVE_ENGAGEMENT');
    expect(outcome.settled).toBe(false);
    expect(outcome.reason).toMatch(/standing commercial authority refused/);
    expect((await getEngagement(prepared.body.engagement.id))!.state).toBe('PROPOSED');
    expect((await getHumanRequest(prepared.body.decisionRequestId))!.state).toBe('OPEN');
  });
});

describe('Brain-read acceptance', () => {
  it('accepts a no-charge result by itself only when every condition reads MET from rows', async () => {
    const order = await openOrder([
      { key: 'named', statement: 'The account is named unambiguously', check: 'ACCOUNT_FOUNDATION', userId: assignee.id, dimension: 'IDENTITY' },
    ]);
    const added = await as(owner, 'POST', `/projects/${projectId}/human-work/orders/${order.id}/candidates`, { relationship: 'TEAM_MEMBER', userId: assignee.id });
    const prepared = await as(owner, 'POST', `/projects/${projectId}/human-work/orders/${order.id}/engagements`, { candidateId: added.body.candidate.id, terms: termsFor() });
    await answerCard(prepared.body.decisionRequestId, owner, 'APPROVE_ENGAGEMENT');
    // Invited is not engaged: the tick accepts nothing yet.
    await runHumanWorkTick();
    expect((await getOrder(order.id))!.state).toBe('OPEN');
    await as(assignee, 'POST', `/assignments/${prepared.body.engagement.id}/answer`, { accept: true });
    const tick = await runHumanWorkTick();
    expect(tick.accepted).toContain(order.id);
    expect((await getOrder(order.id))!.state).toBe('ACCEPTED');
    expect((await listOrders(projectId)).length).toBe(1);
  });
});

describe('the Claude-capacity recipe', () => {
  it('opens the real shape of the task, judged by the same foundation People reads, and decides nothing', async () => {
    const first = await connectClaudeCapacity({ projectId, memberUserId: assignee.id, actorRef: owner.id });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.order.acceptance.map((one) => one.dimension)).toEqual(['CLAUDE_CONNECTION', 'WORKER_ATTRIBUTION', 'CAPACITY']);
    expect(first.value.engagement!.state).toBe('PROPOSED');
    expect((await getHumanRequest(first.value.decision!.id))!.state).toBe('OPEN');
    // Running it again duplicates nothing.
    const again = await connectClaudeCapacity({ projectId, memberUserId: assignee.id, actorRef: owner.id });
    expect(again.ok && again.value.order.id).toBe(first.value.order.id);
    expect(again.ok && again.value.decision).toBeNull();
    const view = await orderView((await getOrder(first.value.order.id))!);
    expect(view.stage).toBe('AWAITING_AUTHORIZATION');
    expect(view.headline).toMatch(/waiting on your decision/);
  });
});

describe('history', () => {
  it('holds no statement that edits or deletes what somebody did', () => {
    const source = readFileSync(new URL('../server/repos/humanWork.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/DELETE FROM/i);
    expect(source).not.toMatch(/UPDATE human_work_(events|deliverables|reviews|costs)/);
  });
});
