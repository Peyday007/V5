/**
 * Freelance deliverables: what Brain can produce and check, which real jobs
 * that qualifies, and one won job walked from bid to payment.
 *
 * Only the outside world is simulated: Freelancer's API (a local server that
 * keeps bids, threads, messages with attachments and milestones), and the
 * fleet worker, which claims the real bin, submits through the real unit
 * store and asks the real completion contract. Everything between — the
 * screen, the capability proof, the bin, the renderer, the verifier, the
 * store, the effects engine and the ledger — is the real code.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { freshProject, type TestProject } from './helpers.ts';
import { createUser, createWorker } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { forgetAccount, isAcknowledgement, runFreelancerOperation } from '../server/services/cash/freelancer/operate.ts';
import { screenProject } from '../server/services/cash/freelancer/screen.ts';
import { allDeliverables, allJobs } from '../server/repos/marketplaceJobs.ts';
import { assignNextBin, getBin, putBinUnitResult } from '../server/repos/bins.ts';
import { requestCompletion } from '../server/services/bins/service.ts';
import { cashPosition } from '../server/services/cash/money.ts';
import { produce, proveCapabilities } from '../server/services/cash/freelancer/deliverables/capabilities.ts';
import { SAMPLES } from '../server/services/cash/freelancer/deliverables/samples.ts';
import { DELIVERABLE_KINDS, validateSubmission } from '../server/services/cash/freelancer/deliverables/spec.ts';
import { readXlsx } from '../server/services/cash/freelancer/deliverables/xlsx.ts';
import { unzip, zip } from '../server/services/cash/freelancer/deliverables/zip.ts';
import { renderXlsx } from '../server/services/cash/freelancer/deliverables/xlsx.ts';
import { feeUsd, priceJob } from '../server/services/cash/freelancer/economics.ts';
import { readClientFile } from '../server/services/cash/freelancer/fulfil.ts';
import { messyOrdersCsv, PIPELINE_SAMPLE } from '../server/services/cash/freelancer/deliverables/samples.ts';
import { loadTable, runPipeline, toIsoDate, toNumber } from '../server/services/cash/freelancer/deliverables/pipeline.ts';

const NOW = Math.floor(Date.now() / 1000);
const ALL_PROVED = { available: new Set(DELIVERABLE_KINDS), python: true, clientFilesProven: false, clientFileJobsActive: 0 };
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('data work on the client’s own file, run by Brain from declared steps', () => {
  it('cleans and aggregates five thousand messy rows, and writes a change log', async () => {
    const produced = await produce(JSON.stringify({ spec: PIPELINE_SAMPLE.spec }), ['DATASET'], { files: new Map([[PIPELINE_SAMPLE.file, messyOrdersCsv()]]) });
    expect(produced.ok, produced.problems.join(' ')).toBe(true);
    const log = produced.files.find((f) => f.name.endsWith('change log.md'))!.bytes.toString();
    expect(log).toMatch(/Read 5020 row/);
    expect(log).toMatch(/Removed 20 duplicate row/);
    expect(log).toMatch(/Result: 12 row/);
    const book = readXlsx(produced.files.find((f) => f.name.endsWith('.xlsx'))!.bytes)[0]!;
    // Twelve region-months, every order counted once: 5000 distinct orders.
    let orders = 0;
    for (let r = 1; r <= book.maxRow; r += 1) orders += Number(book.cells.get(`${r},3`)?.value);
    expect(orders).toBe(5000);
  });

  it('normalises the values clients actually send', () => {
    expect(toNumber('$1,234.50')).toBe(1234.5);
    expect(toNumber('(120)')).toBe(-120);
    expect(toNumber('12%')).toBe(0.12);
    expect(toNumber('n/a')).toBe('n/a');
    expect(toIsoDate('03/04/2025', 'DMY')).toBe('2025-04-03');
    expect(toIsoDate('03/04/2025', 'MDY')).toBe('2025-03-04');
    expect(toIsoDate('31/02/2025', 'DMY')).toBe('31/02/2025');
    expect(toIsoDate(45667, 'YMD')).toBe('2025-01-10');
  });

  it('refuses a step naming a column or file that is not there, rather than guessing', async () => {
    const t = loadTable('a.csv', Buffer.from('Name,Amount\nA,1\nB,2\n'));
    expect(() => runPipeline(t, [{ op: 'sort', column: 'Price', order: 'asc' }], () => t)).toThrow(/No column "Price"/);
    const missing = await produce(JSON.stringify({ spec: { ...PIPELINE_SAMPLE.spec, source: { file: 'other.csv' } } }), undefined, { files: new Map() });
    expect(missing.problems.join(' ')).toMatch(/no file named "other.csv"/);
    expect(validateSubmission(JSON.stringify({ spec: { ...PIPELINE_SAMPLE.spec, steps: [{ op: 'exec', code: 'rm -rf /' }] } })).ok).toBe(false);
  });
});

describe('every category is proved by producing its sample', () => {
  it('renders and verifies all eight samples', async () => {
    const caps = await proveCapabilities();
    for (const kind of DELIVERABLE_KINDS) expect(caps[kind].available, `${kind}: ${caps[kind].detail}`).toBe(true);
  });

  it('computes the formulas it delivers, and refuses one that errors', async () => {
    const book = renderXlsx(SAMPLES.SPREADSHEET.spec.kind === 'SPREADSHEET' ? SAMPLES.SPREADSHEET.spec.sheets : []);
    const summary = readXlsx(book.bytes).find((s) => s.name === 'Summary')!;
    // Month one: 18 000 sales, 5 760 ingredients, 10 350 fixed costs, from a 10 000 opening balance.
    expect(summary.cells.get('4,1')?.value).toBeGreaterThan(10_000);
    expect(summary.cells.get('4,1')?.formula).toBe("MIN('Cash Flow'!H2:H13)");
    const broken = clone(SAMPLES.SPREADSHEET.spec) as { sheets: { rows: unknown[][] }[] };
    broken.sheets[2]!.rows[5] = ['Margin', { f: 'B3/0' }];
    const refused = await produce(JSON.stringify({ spec: broken }));
    expect(refused.ok).toBe(false);
    expect(refused.problems.join(' ')).toMatch(/#DIV\/0!/);
    const unknown = clone(SAMPLES.SPREADSHEET.spec) as { sheets: { rows: unknown[][] }[] };
    unknown.sheets[2]!.rows[5] = ['X', { f: 'XLOOKUP(1,A1:A2,B1:B2)' }];
    expect((await produce(JSON.stringify({ spec: unknown }))).problems.join(' ')).toMatch(/does not evaluate: XLOOKUP/);
  });

  it('refuses what it cannot stand behind, naming each problem', async () => {
    const svg = clone(SAMPLES.GRAPHIC.spec) as { svg: string };
    svg.svg = svg.svg.replace('</svg>', '<script>alert(1)</script></svg>');
    expect((await produce(JSON.stringify({ spec: svg }))).problems.join(' ')).toMatch(/contains a script/);

    const site = clone(SAMPLES.WEBSITE.spec) as { files: { path: string; content: string }[] };
    site.files = site.files.filter((f) => f.path !== 'js/main.js');
    expect((await produce(JSON.stringify({ spec: site }))).problems.join(' ')).toMatch(/js\/main\.js/);

    const code = clone(SAMPLES.CODE.spec) as { files: { path: string; content: string }[] };
    code.files[0]!.content = 'def broken(:\n    pass\n';
    expect((await produce(JSON.stringify({ spec: code }))).problems.join(' ')).toMatch(/summarize\.py:1/);

    const deck = clone(SAMPLES.PRESENTATION.spec) as { slides: { bullets?: string[] }[] };
    deck.slides[1]!.bullets = Array.from({ length: 8 }, () => 'A very long bullet point that keeps going and going well past what any slide can hold at a readable size. '.repeat(2).trim());
    expect((await produce(JSON.stringify({ spec: deck }))).problems.join(' ')).toMatch(/does not fit/);

    expect(validateSubmission(JSON.stringify({ spec: SAMPLES.DATASET.spec, message: 'Email me at a@b.com' })).ok).toBe(false);
    expect(validateSubmission(JSON.stringify({ spec: { ...SAMPLES.DATASET.spec, extra: 1 } })).ok).toBe(false);
    expect((await produce(JSON.stringify({ spec: SAMPLES.DATASET.spec }), ['SPREADSHEET'])).problems.join(' ')).toMatch(/asks for SPREADSHEET/);
  });

  it('reads a client’s files and never mistakes a scan for text', async () => {
    const book = renderXlsx([{ name: 'Orders', rows: [['date', 'amount'], ['2026-01-02', 10], ['2026-01-03', { f: 'B2*2' }]] }]);
    const read = await readClientFile('orders.xlsx', book.bytes);
    expect(read.readable).toBe(true);
    expect(read.text).toMatch(/20 \[=B2\*2\]/);
    expect((await readClientFile('photo.jpg', Buffer.from([0xff, 0xd8, 0xff]))).readable).toBe(false);
    expect(() => unzip(zip([{ name: '../evil', data: Buffer.from('x') }]))).toThrow();
  });
});

function listing(id: number, over: Record<string, unknown> = {}) {
  return {
    id,
    owner_id: 9000 + id,
    title: 'Excel cash-flow budget for my bakery',
    seo_url: `excel/bakery-${id}`,
    status: 'active',
    frontend_project_status: 'open',
    type: 'fixed',
    description:
      'I need an Excel 12-month cash-flow budget for my bakery with formulas: monthly sales growing 3% a month, ingredient ' +
      'costs as a share of sales, rent, wages and utilities, a running balance and a summary sheet. I will send last ' +
      'year’s sales as a CSV file so the starting figures are right.',
    currency: { code: 'USD', exchange_rate: 1 },
    budget: { minimum: 60, maximum: 120 },
    bid_stats: { bid_count: 9, bid_avg: 90 },
    time_submitted: NOW - 3600,
    bidperiod: 3,
    jobs: [{ name: 'Excel' }, { name: 'Spreadsheets' }, { name: 'Financial Modeling' }],
    upgrades: {},
    language: 'en',
    ...over,
  };
}

describe('the screen decides by verified capability, not by category name', () => {
  it('qualifies a spreadsheet job once spreadsheets are proved, and not before', () => {
    const job = listing(1) as never;
    expect(screenProject(job, Date.now()).reasons.join(' ')).toMatch(/spreadsheet, which Brain has not proved/);
    const verdict = screenProject(job, Date.now(), ALL_PROVED);
    expect(verdict.deliverable).toBe(true);
    expect(verdict.categories).toEqual(['SPREADSHEET']);
    expect(verdict.needsClientFiles).toBe(true);
    expect(verdict.economics?.feeUsd).toBe(8.1);
  });

  it('keeps refusing the real listings that need a person, an engineer or the client’s systems', () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ title: 'Experienced PCB Design Engineer Needed', jobs: [{ name: 'PCB Layout' }, { name: 'Electrical Engineering' }], description: 'PCB schematic design and layout, routing, DRC, Gerber files and BOM for manufacturing, with a written design report. '.repeat(2) }, /qualified engineer|electronics design/],
      [{ title: 'Fire Damage Assessment Needed', jobs: [{ name: 'Structural Engineering' }, { name: 'Building Inspection' }], description: 'I need a professional to assess fire damage in my attic with a visual inspection of roof beams and a detailed damage report for insurance. '.repeat(2) }, /inspection|engineer/],
      [{ title: 'Rewrite IEEE AI Paper', jobs: [{ name: 'Technical Writing' }, { name: 'Academic Writing' }], description: 'Rewrite my AI research manuscript for an IEEE journal by a human editor so it does not sound machine-generated; return a report of changes. '.repeat(2) }, /academic|AI-produced/],
      [{ title: 'Playwright TypeScript tests', jobs: [{ name: 'Test Automation' }, { name: 'Typescript' }], description: 'You pull the existing repo, review the conventions, and add Playwright specs in TypeScript to our framework, passing npx playwright test. '.repeat(2) }, /existing codebase|TypeScript|own application/],
      [{ title: 'Update my WordPress site', jobs: [{ name: 'WordPress' }, { name: 'HTML' }], description: 'Fix the landing page on my existing WordPress website, I will give you admin access to the dashboard to change the hero section. '.repeat(2) }, /client’s site|systems or hosting/],
      [{ title: 'Build a lead list', jobs: [{ name: 'Data Entry' }, { name: 'Lead Generation' }], description: 'Compile a CSV of 500 dentists in Texas with emails and phone numbers of the decision makers for my outreach campaign next month. '.repeat(2) }, /contacting or listing people/],
      // Freelancer project 40772623, qualified in production on 2026-10-19: the
      // client forbids tools, and Brain's bid says the work is AI-assisted.
      // Three prepared in production on 2026-10-21 that Brain could not deliver.
      [{ title: 'Premium Service Google Ad Campaign', jobs: [{ name: 'Google Adwords' }, { name: 'Excel' }], description: 'Set up and manage a Google Ads campaign for my service business: keyword research spreadsheet, ad copy and a weekly report on spend and conversions over the first month. '.repeat(2) }, /ad account/],
      [{ title: 'Intermediate Origami Flower Designs', jobs: [{ name: 'Graphic Design' }, { name: 'Illustrator' }], description: 'I need five original intermediate origami flower designs with clear step-by-step folding diagrams as vector files, each tested so that it folds from a single square sheet. '.repeat(2) }, /folding or craft design|folding design/],
      [{ title: '15k Data Entries with Photos', jobs: [{ name: 'Data Entry' }, { name: 'Excel' }], description: 'Enter 15k entries with photos into a spreadsheet: for each product find the name, price and a photo link and type them into the columns of the sheet in order. '.repeat(2) }, /larger than Brain can pass/],
      [{ title: 'Startup Live Chat Support Agent Needed', jobs: [{ name: 'Website Design' }, { name: 'HTML' }], description: 'I need a reliable live-chat specialist to become the first point of contact for our users during standard business hours (US-Pacific, 9 am-5 pm, Monday-Friday). You will sit inside the website’s chat widget, greet visitors and answer product questions.' }, /staffing a role/],
      [{ title: '15k Data Entries with Photos', jobs: [{ name: 'Data Entry' }, { name: 'Excel' }], description: 'I have 15,000 rows that must be keyed into an Excel workbook, each row containing the details exactly as shown on the source sheet plus a matching JPEG image attached or referenced. I will send the source sheet. Accuracy is critical.' }, /by hand/],
      [{ title: 'Manual Product Data Entry', jobs: [{ name: 'Data Entry' }, { name: 'Excel' }], description: 'I need help transferring product details from a series of public-facing websites into my Excel template. Everything is done by hand—no scraping tools or API connections—so close attention to detail is essential. I will provide the list of URLs and an Excel file already set up with the columns.' }, /by hand, without tools/],
    ];
    for (const [over, reason] of cases) {
      const verdict = screenProject(listing(2, over) as never, Date.now(), ALL_PROVED);
      expect(verdict.deliverable, String(over.title)).toBe(false);
      expect(verdict.reasons.join(' '), String(over.title)).toMatch(reason);
    }
  });

  it('prices a rupee job in rupees, at Freelancer’s rate, net of Freelancer’s fee', () => {
    const verdict = screenProject(
      listing(3, { currency: { code: 'INR', exchange_rate: 0.010534 }, budget: { minimum: 12500, maximum: 37500 }, bid_stats: { bid_count: 4, bid_avg: 20000 } }) as never,
      Date.now(),
      ALL_PROVED,
    );
    expect(verdict.deliverable).toBe(true);
    expect(verdict.economics?.currency).toBe('INR');
    expect(verdict.economics?.bid).toBe(18000);
    expect(verdict.economics?.bidUsd).toBeCloseTo(189.61, 2);
    expect(verdict.economics?.feeUsd).toBe(18.96);
    expect(verdict.economics?.estimate.cashCostUsd).toBe(0);
    expect(feeUsd(30)).toBe(5);
    expect(priceJob({ quote: { code: 'USD', usdPerUnit: 1, source: 'FREELANCER_PROJECT' }, budgetMin: 30, budgetMax: 30, bidAvg: null, categories: ['GRAPHIC'] }).netUsd).toBe(25);
  });

  it('treats a short thank-you as an acknowledgement, and a change request as a revision', () => {
    expect(isAcknowledgement('Thanks, looks good!')).toBe(true);
    expect(isAcknowledgement('Thanks — can you also add a column for profit per month?')).toBe(false);
  });
});

/* =========================================================================
 * One won job, walked
 * ====================================================================== */

interface Msg { id: number; thread_id: number; from_user: number; message: string; time_created: number; attachments?: { filename: string }[]; files?: { name: string; bytes: Buffer }[] }
const world = {
  projects: [] as ReturnType<typeof listing>[],
  bids: [] as { id: number; project_id: number; bidder_id: number; amount: number; award_status: string | null; retracted: boolean }[],
  threads: [] as { id: number; project: number }[],
  messages: [] as Msg[],
  attachments: new Map<string, Buffer>(),
  milestones: [] as { transaction_id: number; project_id: number; bid_id: number; amount: number; status: string }[],
};
let nextId = 500;
let server: Server;
const ok = (res: express.Response, result: unknown) => res.json({ status: 'success', result });

function parseMultipart(raw: Buffer, type: string): { fields: Record<string, string[]>; files: { name: string; bytes: Buffer }[] } {
  const boundary = /boundary=([^;]+)/.exec(type)![1]!;
  const fields: Record<string, string[]> = {};
  const files: { name: string; bytes: Buffer }[] = [];
  const marker = Buffer.from(`--${boundary}`);
  let start = raw.indexOf(marker);
  while (start >= 0) {
    const next = raw.indexOf(marker, start + marker.length);
    if (next < 0) break;
    const part = raw.subarray(start + marker.length + 2, next - 2);
    const split = part.indexOf('\r\n\r\n');
    const head = part.subarray(0, split).toString('utf8');
    const body = part.subarray(split + 4);
    const name = /name="([^"]+)"/.exec(head)?.[1] ?? '';
    const filename = /filename="([^"]+)"/.exec(head)?.[1];
    if (filename) files.push({ name: filename, bytes: Buffer.from(body) });
    else (fields[name] ??= []).push(body.toString('utf8'));
    start = next;
  }
  return { fields, files };
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
  app.get('/api/projects/0.1/projects/:id/', (req, res) => ok(res, { ...world.projects.find((p) => p.id === Number(req.params.id)), attachments: [] }));
  app.get('/api/users/0.1/self/', (req, res) => authed(req, res) && ok(res, { id: 777, username: 'owner' }));
  app.post('/api/projects/0.1/bids/', (req, res) => {
    if (!authed(req, res)) return;
    const bid = { id: nextId++, project_id: req.body.project_id, bidder_id: req.body.bidder_id, amount: req.body.amount, award_status: null, retracted: false };
    world.bids.push(bid);
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
    const type = req.header('content-type') ?? '';
    let message = String(req.body?.message ?? '');
    let files: Msg['files'];
    if (type.startsWith('multipart/form-data')) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const parsed = parseMultipart(Buffer.concat(chunks), type);
      files = parsed.files;
      message = parsed.fields.message?.[0] ?? '';
    }
    const m: Msg = { id: nextId++, thread_id: Number(req.params.id), from_user: 777, message, time_created: NOW, files };
    world.messages.push(m);
    ok(res, m);
  });
  app.get('/api/messages/0.1/messages/', (req, res) => {
    if (!authed(req, res)) return;
    const threads = ([] as unknown[]).concat(req.query.threads ?? []).map(Number);
    ok(res, { messages: world.messages.filter((m) => threads.includes(m.thread_id)).map(({ files: _files, ...rest }) => rest) });
  });
  app.get('/api/messages/0.1/threads/:id/attachments/:name', (req, res) => {
    if (!authed(req, res)) return;
    const bytes = world.attachments.get(`${req.params.id}/${req.params.name}`);
    if (!bytes) {
      res.status(404).end();
      return;
    }
    res.type('application/octet-stream').send(bytes);
  });
  app.post('/api/projects/0.1/milestone_requests/', (req, res) => {
    if (!authed(req, res)) return;
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
let workerId = '';

beforeEach(async () => {
  Object.assign(world, { projects: [], bids: [], threads: [], messages: [], milestones: [] });
  world.attachments.clear();
  forgetAccount();
  fixture = await freshProject();
  projectId = fixture.project.id;
  const owner = await createUser({ email: `fd-${Math.random().toString(36).slice(2)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple', isBrainAdmin: true });
  ownerId = owner.id;
  expect((await activate({ projectId, ownerUserId: ownerId, actorUserId: ownerId, objective: 'Earn from work Brain can deliver itself', currency: 'USD' })).ok).toBe(true);
  workerId = (await createWorker({ name: `fleet-${Math.random().toString(36).slice(2)}`, createdByType: 'SYSTEM', createdById: 't' })).id;
  process.env.FREELANCER_OAUTH_TOKEN = 'test-token';
  await createAuthority({
    projectId,
    ownerUserId: ownerId,
    createdByUserId: ownerId,
    name: 'Freelancer jobs',
    allowedActions: ['CONTACT_BUYER', 'QUOTE_AND_INVOICE', 'ACCEPT_PAYMENT'],
    prohibitions: [],
    maxCommittedCents: 0,
    maxPerActionCents: 0,
    maxConcurrent: 2,
    currency: 'USD',
  });
});

afterEach(() => {
  delete process.env.FREELANCER_OAUTH_TOKEN;
});

const tick = (offsetMs = 0) => runFreelancerOperation(projectId, Date.now() + offsetMs);

/** The fleet worker: take the ready bin, submit, ask the real contract. */
async function work(value: string): Promise<{ completed: boolean; reasons: string[]; binId: string }> {
  const assigned = await assignNextBin({ workerId, projectIds: [projectId] });
  expect(assigned, 'a bin was ready for the worker').toBeTruthy();
  const proof = { binId: assigned!.bin.id, leaseId: assigned!.leaseId, leaseGeneration: assigned!.leaseGeneration, workerId };
  const unitKey = assigned!.bin.createdById?.startsWith('freelancer:reply:') ? 'reply' : 'deliverable';
  await putBinUnitResult({ ...proof, unitKey, value, contentHash: String(value.length), submittedBy: workerId });
  const outcome = await requestCompletion({ workerId, proof });
  if (outcome.state === 'COMPLETE') return { completed: true, reasons: [], binId: proof.binId };
  // The worker corrects within the same lease, as a real one does after a refusal.
  return { completed: false, reasons: outcome.verdict?.reasons ?? [], binId: proof.binId };
}

async function correct(binId: string, value: string): Promise<boolean> {
  const bin = (await getBin(binId))!;
  const proof = { binId, leaseId: bin.leaseId!, leaseGeneration: bin.leaseGeneration, workerId };
  await putBinUnitResult({ ...proof, unitKey: 'deliverable', value, contentHash: `${value.length}x`, submittedBy: workerId });
  return (await requestCompletion({ workerId, proof })).state === 'COMPLETE';
}

describe('a won spreadsheet job, from bid to payment', () => {
  it('bids, waits for the client’s file, produces, is corrected, delivers, revises once, and is paid once', async () => {
    world.projects = [listing(70)];
    await tick();
    let job = (await allJobs(projectId))[0]!;
    expect(job.state).toBe('BID_SENT');
    expect(job.categories).toEqual(['SPREADSHEET']);
    expect(job.economics?.feeUsd).toBe(8.1);

    // A question before the award is answered by the fleet.
    world.threads.push({ id: 900, project: 70 });
    world.messages.push({ id: 901, thread_id: 900, from_user: 9070, message: 'Can it also show a break-even month?', time_created: NOW });
    await tick();
    const reply = await work('Yes. The summary sheet will show the first month the running balance stays above the opening balance.');
    expect(reply.completed).toBe(true);
    await tick();
    expect(world.messages.some((m) => m.from_user === 777 && /summary sheet will show/.test(m.message))).toBe(true);

    world.bids[0]!.award_status = 'awarded';
    await tick();
    job = (await allJobs(projectId))[0]!;
    expect(job.state).toBe('FULFILLING');
    expect(job.deliverableBinId).toBeNull();
    expect(world.messages.filter((m) => /please send the files/i.test(m.message))).toHaveLength(1);

    // The client sends the CSV in the thread.
    world.messages.push({ id: 950, thread_id: 900, from_user: 9070, message: 'Here is last year', time_created: NOW, attachments: [{ filename: 'sales-2025.csv' }] });
    world.attachments.set('900/sales-2025.csv', Buffer.from('month,sales\nDec,17800\n'));
    await tick();
    job = (await allJobs(projectId))[0]!;
    expect(job.deliverableBinId).toBeTruthy();
    expect(job.clientFiles?.[0]).toMatchObject({ name: 'sales-2025.csv', readable: true });
    const brief = (await getBin(job.deliverableBinId!))!.manifest.units[0]!.input;
    expect(brief).toMatch(/Dec,17800/);
    expect(brief).toMatch(/break-even/);

    // First submission breaks a formula; the contract says so; the worker fixes it.
    const bad = clone(SAMPLES.SPREADSHEET.spec) as { sheets: { rows: unknown[][] }[] };
    bad.sheets[2]!.rows[5] = ['Net margin', { f: 'B3/0', fmt: 'percent' }];
    const first = await work(JSON.stringify({ spec: bad }));
    expect(first.completed).toBe(false);
    expect(first.reasons.join(' ')).toMatch(/#DIV\/0!/);
    expect(await correct(first.binId, JSON.stringify({ spec: SAMPLES.SPREADSHEET.spec, message: 'Your 12-month budget is attached.' }))).toBe(true);

    await tick();
    job = (await allJobs(projectId))[0]!;
    expect(job.state).toBe('DELIVERED');
    const delivery = world.messages.find((m) => m.files?.length);
    expect(delivery?.files?.map((f) => f.name)).toEqual(['Bakery 12-month cash flow.xlsx']);
    const delivered = readXlsx(delivery!.files![0]!.bytes);
    expect(delivered.map((s) => s.name)).toEqual(['Assumptions', 'Cash Flow', 'Summary']);
    expect(world.milestones[0]!.status).toBe('requested_release');
    let versions = await allDeliverables(projectId);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.state).toBe('DELIVERED');
    expect(versions[0]!.verification.checks.every((c) => c.ok)).toBe(true);

    // The client asks for a change: a revision, as a new version.
    world.messages.push({ id: 960, thread_id: 900, from_user: 9070, message: 'Please make the opening balance 12,000.', time_created: NOW });
    await tick();
    job = (await allJobs(projectId))[0]!;
    expect(job.state).toBe('FULFILLING');
    expect(job.revisions).toBe(1);
    const revised = clone(SAMPLES.SPREADSHEET.spec) as { sheets: { rows: unknown[][] }[] };
    revised.sheets[0]!.rows[7] = ['Opening cash balance', { v: 12000, fmt: 'currency' }];
    expect((await work(JSON.stringify({ spec: revised, message: 'Updated: opening balance is now 12,000.' }))).completed).toBe(true);
    await tick();
    job = (await allJobs(projectId))[0]!;
    expect(job.state).toBe('DELIVERED');
    versions = await allDeliverables(projectId);
    expect(versions.map((v) => [v.version, v.state])).toEqual([[1, 'DELIVERED'], [2, 'DELIVERED']]);
    expect(versions[0]!.files[0]!.sha256).not.toBe(versions[1]!.files[0]!.sha256);

    // A thank-you is not a third version.
    world.messages.push({ id: 970, thread_id: 900, from_user: 9070, message: 'Thanks, perfect!', time_created: NOW });
    await tick();
    expect((await allJobs(projectId))[0]!.state).toBe('DELIVERED');

    world.milestones[0]!.status = 'cleared';
    await tick();
    expect((await allJobs(projectId))[0]!.state).toBe('PAID');
    const position = await cashPosition({ projectId, currency: 'USD' });
    expect(position.customerPaymentsCents).toBe(Math.round(world.milestones[0]!.amount * 100));

    const before = { messages: world.messages.length, money: position.customerPaymentsCents };
    await tick(61 * 60 * 1000);
    expect(world.messages.length).toBe(before.messages);
    expect((await cashPosition({ projectId, currency: 'USD' })).customerPaymentsCents).toBe(before.money);
  });

  it('converts a rupee payment into the sprint’s dollars at Freelancer’s own rate', async () => {
    world.projects = [listing(80, { currency: { code: 'INR', exchange_rate: 0.010534 }, budget: { minimum: 12500, maximum: 37500 }, bid_stats: { bid_count: 4, bid_avg: 20000 }, description: listing(80).description.replace(' I will send last year’s sales as a CSV file so the starting figures are right.', ' Use typical figures for a small bakery and label every assumption clearly in its own sheet.') })];
    await tick();
    world.bids[0]!.award_status = 'awarded';
    await tick();
    expect((await work(JSON.stringify({ spec: SAMPLES.SPREADSHEET.spec }))).completed).toBe(true);
    await tick();
    expect((await allJobs(projectId))[0]!.state).toBe('DELIVERED');
    world.milestones[0]!.status = 'cleared';
    await tick();
    const position = await cashPosition({ projectId, currency: 'USD' });
    expect(position.customerPaymentsCents).toBe(Math.round(18000 * 0.010534 * 100));
  });
});
