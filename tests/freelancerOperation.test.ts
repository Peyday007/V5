/**
 * The Freelancer operation, walked end to end against a fake Freelancer.
 *
 * Only the outside world is simulated: Freelancer's API (a local server that
 * keeps its own bids, threads, milestones and messages), and the research
 * fleet's work, which is represented by the packet the real research-goal pass
 * starts being marked COMPLETE with a filed document — the pipeline itself is
 * walked in `researchIntelligencePass` and `cashIntegrationPass`. Everything
 * between — discovery, the screen, the grant check, the effects engine, the
 * goal, the delivery, the milestone and the ledger — is the real code.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { addDocument, freshProject, type TestProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { forgetAccount, runFreelancerOperation } from '../server/services/cash/freelancer/operate.ts';
import { screenProject } from '../server/services/cash/freelancer/screen.ts';
import { DELIVERABLE_KINDS } from '../server/services/cash/freelancer/deliverables/spec.ts';

/** Every deliverable kind proved, as a production process with a passing self-proof sees it. */
const ALL_PROVED = { available: new Set(DELIVERABLE_KINDS), python: true, clientFilesProven: false, clientFileJobsActive: 0 };
import { allJobs } from '../server/repos/marketplaceJobs.ts';
import { advanceResearchGoals } from '../server/services/research/goalContinuation.ts';
import { getDb } from '../server/db/database.ts';
import { updateOrchestration } from '../server/repos/research.ts';
import { cashPosition } from '../server/services/cash/money.ts';

const NOW = Math.floor(Date.now() / 1000);

function project(id: number, over: Record<string, unknown> = {}) {
  return {
    id,
    owner_id: 9000 + id,
    title: 'Competitor analysis of meal-kit delivery services in the US',
    seo_url: `research/competitor-${id}`,
    status: 'active',
    frontend_project_status: 'open',
    type: 'fixed',
    description:
      'I need a competitor analysis report comparing the top five US meal-kit delivery services: pricing, ' +
      'delivery areas and published subscriber numbers, from public sources.',
    currency: { code: 'USD' },
    budget: { minimum: 100, maximum: 250 },
    bid_stats: { bid_count: 12, bid_avg: 180 },
    time_submitted: NOW - 3600,
    bidperiod: 4,
    jobs: [{ name: 'Market Research' }, { name: 'Research' }],
    upgrades: {},
    language: 'en',
    ...over,
  };
}

/** Freelancer, as far as this operation can see it. */
const world = {
  projects: [] as ReturnType<typeof project>[],
  bids: [] as { id: number; project_id: number; bidder_id: number; amount: number; award_status: string | null; retracted: boolean }[],
  threads: [] as { id: number; project: number }[],
  messages: [] as { id: number; thread_id: number; from_user: number; message: string; time_created: number; attachment?: string }[],
  milestones: [] as { transaction_id: number; project_id: number; bid_id: number; amount: number; status: string }[],
  bidPosts: 0,
  failNextBidAfterRecording: false,
};
let nextId = 100;
let server: Server;

function ok(res: express.Response, result: unknown) {
  res.json({ status: 'success', result });
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  const authed = (req: express.Request, res: express.Response) => {
    if (req.header('freelancer-oauth-v1') !== 'test-token') {
      res.status(401).json({ status: 'error', message: 'bad token', error_code: 'AUTH' });
      return false;
    }
    return true;
  };
  app.get('/api/projects/0.1/projects/active/', (_req, res) => ok(res, { projects: world.projects }));
  app.get('/api/projects/0.1/projects/:id/', (req, res) => ok(res, world.projects.find((p) => p.id === Number(req.params.id))));
  app.get('/api/users/0.1/self/', (req, res) => authed(req, res) && ok(res, { id: 777, username: 'owner' }));
  app.post('/api/projects/0.1/bids/', (req, res) => {
    if (!authed(req, res)) return;
    world.bidPosts += 1;
    const bid = { id: nextId++, project_id: req.body.project_id, bidder_id: req.body.bidder_id, amount: req.body.amount, award_status: null, retracted: false };
    world.bids.push(bid);
    if (world.failNextBidAfterRecording) {
      world.failNextBidAfterRecording = false;
      res.status(502).end();
      return;
    }
    ok(res, bid);
  });
  app.get('/api/projects/0.1/bids/', (req, res) => {
    if (!authed(req, res)) return;
    const projects = ([] as unknown[]).concat(req.query.projects ?? []).map(Number);
    ok(res, { bids: world.bids.filter((b) => projects.includes(b.project_id)) });
  });
  app.put('/api/projects/0.1/bids/:id/', (req, res) => authed(req, res) && ok(res, { id: Number(req.params.id) }));
  app.get('/api/messages/0.1/threads/', (req, res) => {
    if (!authed(req, res)) return;
    ok(res, { threads: world.threads.filter((t) => t.project === Number(req.query.context)) });
  });
  app.post('/api/messages/0.1/threads/', (req, res) => {
    if (!authed(req, res)) return;
    const thread = { id: nextId++, project: Number(req.body.context) };
    world.threads.push(thread);
    world.messages.push({ id: nextId++, thread_id: thread.id, from_user: 777, message: req.body.message, time_created: NOW });
    ok(res, { id: thread.id });
  });
  app.post('/api/messages/0.1/threads/:id/messages/', async (req, res) => {
    if (!authed(req, res)) return;
    // A multipart upload is the report; this fake keeps the raw body to read its name.
    let attachment: string | undefined;
    if ((req.header('content-type') ?? '').startsWith('multipart/form-data')) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      attachment = /filename="([^"]+)"/.exec(raw)?.[1] ?? 'unnamed';
      if (!raw.includes('Meal-kit competitor analysis')) attachment = undefined;
    }
    const message = { id: nextId++, thread_id: Number(req.params.id), from_user: 777, message: String(req.body?.message ?? ''), time_created: NOW, attachment };
    world.messages.push(message);
    ok(res, message);
  });
  app.get('/api/messages/0.1/messages/', (req, res) => {
    if (!authed(req, res)) return;
    const threads = ([] as unknown[]).concat(req.query.threads ?? []).map(Number);
    ok(res, { messages: world.messages.filter((m) => threads.includes(m.thread_id)) });
  });
  app.post('/api/projects/0.1/milestone_requests/', (req, res) => {
    if (!authed(req, res)) return;
    // The client funds what was requested at once, in this fake.
    world.milestones.push({ transaction_id: nextId++, project_id: req.body.project_id, bid_id: req.body.bid_id, amount: req.body.amount, status: 'frozen' });
    ok(res, { id: nextId++ });
  });
  app.get('/api/projects/0.1/milestones/', (req, res) => {
    if (!authed(req, res)) return;
    const projects = ([] as unknown[]).concat(req.query.projects ?? []).map(Number);
    ok(res, { milestones: world.milestones.filter((m) => projects.includes(m.project_id)) });
  });
  app.put('/api/projects/0.1/milestones/:id/', (req, res) => {
    if (!authed(req, res)) return;
    const m = world.milestones.find((one) => one.transaction_id === Number(req.params.id));
    if (m) m.status = 'requested_release';
    ok(res, {});
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  process.env.FREELANCER_API_BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.env.FREELANCER_API_BASE = 'http://127.0.0.1:9'; // the setup default: never the live market
  delete process.env.FREELANCER_OAUTH_TOKEN;
});

let fixture: TestProject;
let projectId = '';
let ownerId = '';

beforeEach(async () => {
  world.projects = [];
  world.bids = [];
  world.threads = [];
  world.messages = [];
  world.milestones = [];
  world.bidPosts = 0;
  delete process.env.FREELANCER_OAUTH_TOKEN;
  forgetAccount();
  fixture = await freshProject();
  projectId = fixture.project.id;
  const owner = await createUser({ email: `fl-${Math.random().toString(36).slice(2)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple', isBrainAdmin: true });
  ownerId = owner.id;
  const activated = await activate({ projectId, ownerUserId: ownerId, actorUserId: ownerId, objective: 'Earn from research jobs Brain can deliver itself', currency: 'USD' });
  expect(activated.ok).toBe(true);
});

afterEach(() => {
  delete process.env.FREELANCER_OAUTH_TOKEN;
});

async function grant(actions: string[]) {
  await createAuthority({
    projectId,
    ownerUserId: ownerId,
    createdByUserId: ownerId,
    name: 'Freelancer research jobs',
    allowedActions: actions,
    prohibitions: [],
    maxCommittedCents: 0,
    maxPerActionCents: 0,
    maxConcurrent: 2,
    currency: 'USD',
  });
}

const tick = (offsetMs = 0) => runFreelancerOperation(projectId, Date.now() + offsetMs);

describe('the screen', () => {
  it('turns down a job whose only delivery plan is somebody’s labour, and says why', () => {
    const phone = screenProject(project(1, { description: 'Market research by calling 50 restaurants by phone.' }) as never, Date.now());
    expect(phone.deliverable).toBe(false);
    expect(phone.reasons.join(' ')).toMatch(/calls, meetings or presence/);
    const files = screenProject(project(2, { description: 'Market research report. I will send the PDFs attached.' }) as never, Date.now());
    expect(files.reasons.join(' ')).toMatch(/files the client sends/);
    const academic = screenProject(project(3, { description: 'Market research for my university assignment.' }) as never, Date.now());
    expect(academic.reasons.join(' ')).toMatch(/academic/);
    expect(screenProject(project(4) as never, Date.now()).deliverable).toBe(true);
  });

  it('turns down the farm business plan production prepared on its first scan', () => {
    // Freelancer 40775349, as published on 2026-10-19: an investor-ready plan with
    // editable financial models and 3D work. Brain's first production scan
    // prepared a bid on it; a research report cannot deliver it. With spreadsheets
    // and documents now proved, it is still refused: the 3D site renders are not
    // something placed primitives can deliver, and it asks for three kinds at once.
    const farm = screenProject(
      project(5, {
        title: 'Export-Oriented Multi-Farm Plan (245 hectares North Africa)',
        jobs: [{ name: '3D Rendering' }, { name: 'Business Plans' }, { name: 'Business Analysis' }, { name: 'Market Research' }],
        description:
          'I need a complete, investor-ready business plan. Market analysis that quantifies overseas demand. ' +
          'Detailed financial projections (start-up costs, P&L, cash-flow, break-even). Executive summary, full ' +
          'references and editable financial models (Excel or Google Sheets) are essential for board review.',
      }) as never,
      Date.now(),
      ALL_PROVED,
    );
    expect(farm.deliverable).toBe(false);
    expect(farm.reasons.join(' ')).toMatch(/3D work needs more than placed primitive shapes/);
    expect(farm.reasons.join(' ')).toMatch(/also asks for 3D model/);
  });
});

describe('the operation', () => {
  it('discovers and prepares without an account, and says exactly what is missing to act', async () => {
    world.projects = [project(10), project(11, { type: 'hourly' })];
    const report = await tick();
    expect(report?.prepared).toBe(1);
    expect(report?.blocked).toMatch(/FREELANCER_OAUTH_TOKEN is not set/);
    const jobs = await allJobs(projectId);
    expect(jobs.map((j) => j.state).sort()).toEqual(['PREPARED', 'REJECTED']);
    expect(world.bidPosts).toBe(0);
  });

  it('withdraws a prepared job the screen no longer passes, without an account', async () => {
    world.projects = [project(15)];
    await tick();
    expect((await allJobs(projectId))[0]!.state).toBe('PREPARED');
    world.projects[0] = project(15, {
      description:
        'I need a competitor analysis report comparing the top five US meal-kit delivery services from public sources, ' +
        'and we will hold weekly calls to go through the findings together.',
    });
    await tick(31 * 60 * 1000);
    const job = (await allJobs(projectId))[0]!;
    expect(job.state).toBe('WITHDRAWN');
    expect(job.stateReason).toMatch(/calls, meetings or presence/);
  });

  it('does not bid without the commercial grant, even when connected', async () => {
    world.projects = [project(20)];
    process.env.FREELANCER_OAUTH_TOKEN = 'test-token';
    const report = await tick();
    expect(report?.blocked).toMatch(/CONTACT_BUYER/);
    expect(world.bidPosts).toBe(0);
  });

  it('bids, wins, researches, delivers, collects — and a replay doubles nothing', async () => {
    world.projects = [project(30)];
    process.env.FREELANCER_OAUTH_TOKEN = 'test-token';
    await grant(['CONTACT_BUYER', 'QUOTE_AND_INVOICE', 'ACCEPT_PAYMENT']);

    await tick();
    expect(world.bidPosts).toBe(1);
    expect((await allJobs(projectId))[0]!.state).toBe('BID_SENT');
    await tick(31 * 60 * 1000);
    expect(world.bidPosts).toBe(1);

    world.bids[0]!.award_status = 'awarded';
    await tick();
    let job = (await allJobs(projectId))[0]!;
    expect(job.state).toBe('FULFILLING');
    expect(job.goalId).toBeTruthy();
    expect(world.messages.some((m) => /research has started/.test(m.message))).toBe(true);
    expect(world.milestones).toHaveLength(1);

    // The research-goal pass starts the packet on its own.
    await advanceResearchGoals();
    const packet = await getDb().get<{ id: string; layer_id: string }>('SELECT id, layer_id FROM research_orchestrations WHERE goal_id = ?', [job.goalId]);
    expect(packet).toBeTruthy();
    const layerName = (await getDb().get<{ name: string }>('SELECT name FROM layers WHERE id = ?', [packet!.layer_id]))!.name;
    const report = await addDocument(fixture, layerName, '9', { contents: '# Meal-kit competitor analysis\n\nFindings, with sources.' });
    await updateOrchestration(packet!.id, { status: 'COMPLETE', documentId: report.id, verdict: 'PASS' });

    await tick();
    job = (await allJobs(projectId))[0]!;
    expect(job.state).toBe('DELIVERED');
    expect(world.messages.some((m) => m.attachment)).toBe(true);
    expect(world.milestones[0]!.status).toBe('requested_release');

    // The client releases the milestone.
    world.milestones[0]!.status = 'cleared';
    await tick();
    job = (await allJobs(projectId))[0]!;
    expect(job.state).toBe('PAID');
    const position = await cashPosition({ projectId, currency: 'USD' });
    expect(position.customerPaymentsCents).toBe(Math.round(world.milestones[0]!.amount * 100));

    const before = { bids: world.bidPosts, messages: world.messages.length, money: position.customerPaymentsCents };
    await tick(61 * 60 * 1000);
    expect(world.bidPosts).toBe(before.bids);
    expect(world.messages.length).toBe(before.messages);
    expect((await cashPosition({ projectId, currency: 'USD' })).customerPaymentsCents).toBe(before.money);
  });

  it('asks Freelancer after an unknown bid outcome rather than bidding twice', async () => {
    world.projects = [project(40)];
    process.env.FREELANCER_OAUTH_TOKEN = 'test-token';
    await grant(['CONTACT_BUYER']);
    world.failNextBidAfterRecording = true;
    await tick();
    expect(world.bidPosts).toBe(1);
    await tick();
    expect(world.bidPosts).toBe(1);
    expect((await allJobs(projectId))[0]!.state).toBe('BID_SENT');
  });
});
