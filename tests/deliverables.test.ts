/**
 * A deliverable, walked from a person's request to a file they can open.
 *
 * The walk is the point, for the reason §24 and §42 each had to record after
 * finding transitions that were tested and unreachable: a test that arranges
 * its own starting state cannot tell a mechanism from a function nobody calls.
 * So this starts where a person starts — a message in a Russell conversation —
 * and drives the real turn, the real tick, two real bins through the real
 * queue with Brain's own dispatch rows behind them, the real completion
 * contract, the real renderer, the real store and the real HTTP route, and
 * opens what comes back with readers that did not write it.
 *
 * **Simulated**: the Cowork activations. The workers are `WORKER` principals
 * claiming real bins, exactly as `designJudgedWalk` and `cashIntegrationPass`
 * say of themselves. What they submit is fixture content — built from the
 * fixture claims, which is the only honest way a test can compose a document.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { freshProject } from './helpers.ts';
import { createUser, createWorker, grantMembership } from '../server/repos/identity.ts';
import { createConversation, listTurns } from '../server/repos/russellConversations.ts';
import { beginTurn, TURN_UNIT_KEY } from '../server/services/russell/turn.ts';
import {
  assignNextBin,
  claimDispatchIntent,
  ensureDispatchIntent,
  getBin,
  markDispatchSent,
  putBinUnitResult,
  releaseBin,
} from '../server/repos/bins.ts';
import { requestCompletion } from '../server/services/bins/service.ts';
import { hashUnitValue } from '../server/services/bins/contracts.ts';
import { tick } from '../server/services/russell/loop.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, currentFragments, decideClaim, insertClaims, updateFragment } from '../server/repos/research.ts';
import { getDeliverable, listFindings, listVersions } from '../server/repos/deliverables.ts';
import { validateContent, numbersIn } from '../server/services/deliverables/content.ts';
import { resolverFor } from '../server/services/deliverables/evidence.ts';
import { renderDocx } from '../server/services/deliverables/docx.ts';
import { renderXlsx } from '../server/services/deliverables/xlsx.ts';
import { checkDeliverable, parseSheetCells } from '../server/services/deliverables/check.ts';
import { validateReview } from '../server/services/deliverables/review.ts';
import { advanceDeliverables } from '../server/services/deliverables/pipeline.ts';
import { deliverablesRouter } from '../server/routes/deliverables.ts';
import { attachContext, newRequestId } from '../server/services/identity/context.ts';
import type { Principal, Project, ProjectMembership } from '../server/domain/types.ts';
import type { DeliverableSpec } from '../server/domain/deliverables.ts';

let project: Project;
let userId = '';
let conversationId = '';
let claims: Record<string, string> = {};

const SPEC: DeliverableSpec = {
  intendedUse: 'Decide which county to pilot remote recording in',
  audience: 'The operator',
  requiredContents: ['e-recording availability per county', 'recording fees'],
  sourceRequirements: 'Official county sources only',
  acceptanceConditions: ['Every statement cites an official source'],
};

async function seedClaim(fragmentId: string, orchestrationId: string, key: string, text: string, url: string): Promise<void> {
  const [claim] = await insertClaims([
    {
      orchestrationId,
      fragmentId,
      passId: null,
      passKey: 'BROAD_SCAN' as const,
      claim: text,
      sourceUrl: url,
      sourceTitle: `${key} page`,
      sourcePublisher: `${key} County Register of Deeds`,
      sourceDate: '2026-08-01',
      evidenceExcerpt: text,
      evidenceLocator: 'Recording fees',
      evidenceLane: 'official_source',
      retrievedAt: '2026-09-01',
      confidence: 0.9,
      validationState: 'SOURCED' as const,
      validationDetail: null,
      sourced: true,
      primarySource: true,
      claimType: 'SOURCED_FACT' as const,
      contentHash: text,
    },
  ] as unknown as Parameters<typeof insertClaims>[0]);
  await decideClaim(claim!.id, { accepted: true });
  claims[key] = claim!.id;
}

beforeEach(async () => {
  claims = {};
  const fixture = await freshProject();
  project = fixture.project;
  const layer = fixture.layers[0]!;
  const run = await createRun({ projectId: project.id, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'e-recording' });
  const orchestration = await createOrchestration({
    projectId: project.id,
    layerId: layer.id,
    runId: run.id,
    title: 'E-recording',
    assignment: 'Which counties accept electronic recording, and at what fee.',
    provider: 'WORKER',
    autoApprove: false,
  });
  await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId: project.id,
      layerId: layer.id,
      requiredEvidence: [{ id: 'official_source', description: 'county pages', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['county site'],
      excludedSourceTypes: ['blog'],
      completionCriteria: ['a fee'],
      minIndependentSources: 1,
      maxRepairs: 2,
      fragmentIndex: 0,
      fragmentKey: 'erecording',
      question: 'Which counties accept e-recording?',
      dependsOn: [],
      attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  const fragment = (await currentFragments(orchestration.id))[0]!;
  await updateFragment(fragment.id, { status: 'ACCEPTED', completedAt: new Date().toISOString(), blockedReason: null });
  await seedClaim(fragment.id, orchestration.id, 'Oakland', 'Oakland County accepts electronic recording through approved submitters; the recording fee is $30.00 per document.', 'https://www.oakgov.com/rod/recording');
  await seedClaim(fragment.id, orchestration.id, 'Wayne', 'Wayne County accepts electronic recording; the recording fee is $30.00 per document plus a $4.00 surcharge.', 'https://www.waynecounty.com/rod/erecording');

  const user = await createUser({
    email: `owner-${Math.random().toString(36).slice(2)}@example.test`,
    displayName: 'The owner',
    password: 'correct horse battery staple',
    isBrainAdmin: false,
    createdByType: 'SYSTEM',
    createdById: 't',
  });
  userId = user.id;
  await grantMembership({ projectId: project.id, principalType: 'HUMAN', principalId: userId, role: 'MEMBER', scopes: ['project:read'], grantedByType: 'SYSTEM', grantedById: 'test' });
  conversationId = (await createConversation({ ownerUserId: userId, title: 'Recording', projectId: project.id, visibility: 'SHARED' })).id;
});

function principal(): Principal {
  return {
    type: 'HUMAN',
    id: userId,
    handle: 'owner@example.test',
    displayName: 'The owner',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'ses_test',
    authMethod: 'SESSION_COOKIE',
    memberships: [
      {
        id: 'mem',
        projectId: project.id,
        principalType: 'HUMAN',
        principalId: userId,
        role: 'MEMBER',
        scopes: ['project:read'],
        grantedByType: 'SYSTEM',
        grantedById: 'test',
        grantedAt: '2026-01-01T00:00:00.000Z',
        active: true,
      } as ProjectMembership,
    ],
    requestId: 'req',
  } as Principal;
}

async function newWorker(name: string): Promise<string> {
  return (await createWorker({ name: `${name}-${Math.random().toString(36).slice(2, 8)}`, createdByType: 'SYSTEM', createdById: 'test' })).id;
}

/**
 * Brain fires the bin, a worker arrives in `sessionRef`, takes it, submits and
 * asks to complete. The dispatch row is what makes a session attributable —
 * the independence decision reads it, never the worker's own word.
 */
async function answerBin(input: {
  binId: string;
  workerId: string;
  sessionRef: string;
  unitKey: string;
  values: string[];
}): Promise<{ refusals: string[][]; completed: boolean }> {
  const bin = (await getBin(input.binId))!;
  await ensureDispatchIntent(bin);
  const intent = await claimDispatchIntent();
  expect(intent?.binId).toBe(input.binId);
  await markDispatchSent(intent!.id, { routineRef: 'trig_walk', sessionRef: input.sessionRef, projectId: project.id });
  let assigned: Awaited<ReturnType<typeof assignNextBin>> = null;
  const aside: NonNullable<Awaited<ReturnType<typeof assignNextBin>>>[] = [];
  for (let i = 0; i < 8; i += 1) {
    const offered = await assignNextBin({ workerId: input.workerId, projectIds: [project.id] });
    if (!offered) break;
    if (offered.bin.id === input.binId) {
      assigned = offered;
      break;
    }
    aside.push(offered);
  }
  for (const other of aside) await releaseBin({ binId: other.bin.id, leaseId: other.leaseId, leaseGeneration: other.leaseGeneration, workerId: input.workerId });
  expect(assigned, `bin ${input.binId} was never offered`).toBeTruthy();
  const refusals: string[][] = [];
  for (const value of input.values) {
    await putBinUnitResult({
      binId: input.binId,
      unitKey: input.unitKey,
      value,
      contentHash: hashUnitValue(value),
      leaseId: assigned!.leaseId,
      leaseGeneration: assigned!.leaseGeneration,
      submittedBy: input.workerId,
    });
    const outcome = await requestCompletion({
      workerId: input.workerId,
      proof: { binId: input.binId, leaseId: assigned!.leaseId, leaseGeneration: assigned!.leaseGeneration, workerId: input.workerId },
    });
    const verdict = (outcome as unknown as { verdict?: { satisfied: boolean; reasons: string[] } }).verdict;
    if (verdict && !verdict.satisfied) refusals.push(verdict.reasons);
    else return { refusals, completed: true };
  }
  return { refusals, completed: false };
}

function writtenContent(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    title: 'Remote recording pilot: Oakland and Wayne',
    subtitle: 'Which county to start with',
    summary: [{ text: 'Both counties accept electronic recording at $30.00 per document; Wayne adds a $4.00 surcharge.', cites: [claims['Oakland'], claims['Wayne']] }],
    sections: [
      {
        heading: 'E-recording availability',
        covers: [0],
        blocks: [
          { type: 'paragraph', text: 'This section compares the two counties the project has evidence for.', framing: true },
          { type: 'bullets', items: [
            { text: 'Oakland accepts electronic recording through approved submitters.', cites: [claims['Oakland']] },
            { text: 'Wayne accepts electronic recording.', cites: [claims['Wayne']] },
          ] },
        ],
      },
      {
        heading: 'Recording fees',
        covers: [1],
        blocks: [
          { type: 'table', columns: ['County', 'Fee per document', 'Surcharge'], rows: [['Oakland', '$30.00', 'none stated'], ['Wayne', '$30.00', '$4.00']], cites: [claims['Oakland'], claims['Wayne']] },
        ],
      },
    ],
    gaps: [],
    limitations: ['Only two counties are covered by the project’s evidence.'],
    ...over,
  });
}

function passingReview(): string {
  return JSON.stringify({
    verdict: 'PASS',
    summary: 'It answers which county to pilot in, for the operator, from official sources.',
    findings: [{ severity: 'MINOR', about: 'purpose', statement: 'Could name a recommendation.', repair: 'Optional.' }],
    coverage: [
      { requiredContent: 0, met: true, note: 'Both counties.' },
      { requiredContent: 1, met: true, note: 'Fee table.' },
    ],
  });
}

async function asks(content: string, proposal: Record<string, unknown>): Promise<void> {
  const started = await beginTurn({ principal: principal(), conversationId, content });
  expect(started.binId, content).toBeTruthy();
  const worker = await newWorker('turn');
  const offered = await assignNextBin({ workerId: worker, projectIds: [project.id] });
  expect(offered?.bin.id).toBe(started.binId);
  const value = JSON.stringify(proposal);
  await putBinUnitResult({ binId: started.binId!, unitKey: TURN_UNIT_KEY, value, contentHash: hashUnitValue(value), leaseId: offered!.leaseId, leaseGeneration: offered!.leaseGeneration, submittedBy: worker });
  await requestCompletion({ workerId: worker, proof: { binId: started.binId!, leaseId: offered!.leaseId, leaseGeneration: offered!.leaseGeneration, workerId: worker } });
  await tick('deliverable-walk');
}

/* ========================================================================== */

describe('the content contract', () => {
  it('refuses a figure no cited claim states, and accepts it once it traces', async () => {
    const bad = writtenContent({ summary: [{ text: 'Oakland charges $31.50 per document.', cites: [claims['Oakland']] }] });
    const refused = await validateContent({ raw: bad, kind: 'WRITTEN', spec: SPEC, resolve: resolverFor(project.id) });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.problems.join(' ')).toMatch(/31\.5/);
    const good = await validateContent({ raw: writtenContent(), kind: 'WRITTEN', spec: SPEC, resolve: resolverFor(project.id) });
    expect(good.ok).toBe(true);
  });

  it('refuses a citation that is not a claim of this project, and an uncovered requirement', async () => {
    const unknown = await validateContent({ raw: writtenContent({ summary: [{ text: 'x', cites: ['clm_invented'] }] }), kind: 'WRITTEN', spec: SPEC, resolve: resolverFor(project.id) });
    expect(!unknown.ok && unknown.problems.join(' ')).toMatch(/not citable claims of this project/);
    const parsed = JSON.parse(writtenContent());
    parsed.sections = parsed.sections.slice(0, 1);
    const uncovered = await validateContent({ raw: JSON.stringify(parsed), kind: 'WRITTEN', spec: SPEC, resolve: resolverFor(project.id) });
    expect(!uncovered.ok && uncovered.problems.join(' ')).toMatch(/Required content 1/);
    parsed.gaps = [{ requiredContent: 1, reason: 'The project has not established fees.' }];
    const gapped = await validateContent({ raw: JSON.stringify(parsed), kind: 'WRITTEN', spec: SPEC, resolve: resolverFor(project.id) });
    expect(gapped.ok).toBe(true);
  });

  it('refuses a framing paragraph that smuggles a figure', async () => {
    const raw = writtenContent({ summary: [{ text: 'About 450 counties exist.', framing: true }] });
    const result = await validateContent({ raw, kind: 'WRITTEN', spec: SPEC, resolve: resolverFor(project.id) });
    expect(!result.ok && result.problems.join(' ')).toMatch(/framing but states figure/);
    expect(numbersIn('$1,200.50 and 7')).toEqual(['1200.5', '7']);
  });
});

describe('the native check', () => {
  it('opens a rendered workbook, recomputes its formulas and catches a tampered cache', async () => {
    const raw = JSON.stringify({
      title: 'Recording fees',
      description: 'Fees per county.',
      sheets: [{
        name: 'Fees', covers: [0, 1],
        columns: [{ key: 'county', label: 'County', type: 'text' }, { key: 'fee', label: 'Fee', type: 'currency' }, { key: 'link', label: 'Source page', type: 'url' }],
        rows: [
          { values: { county: 'Oakland', fee: 30, link: 'https://www.oakgov.com/rod/recording' }, cites: [claims['Oakland']] },
          { values: { county: 'Wayne', fee: 30, link: 'https://www.waynecounty.com/rod/erecording' }, cites: [claims['Wayne']] },
        ],
        totals: [{ column: 'fee', function: 'AVERAGE' }, { column: 'county', function: 'COUNT' }],
      }],
      gaps: [],
      notes: [],
    });
    const validated = await validateContent({ raw, kind: 'STRUCTURED', spec: SPEC, resolve: resolverFor(project.id) });
    expect(validated.ok).toBe(true);
    if (!validated.ok || validated.value.kind !== 'STRUCTURED') return;
    const meta = { versionNumber: 1, generatedAt: new Date().toISOString(), projectName: 'Deal Dispatch', spec: SPEC, unmetNeeds: [] };
    const rendered = renderXlsx(validated.value.content, validated.claims, meta);
    const good = await checkDeliverable({ bytes: rendered.bytes, content: validated.value, claims: validated.claims, referenceOrder: rendered.referenceOrder, spec: SPEC, unmetNeeds: [] });
    expect(good.report.items.filter((i) => !i.passed)).toEqual([]);
    expect(good.passed).toBe(true);

    // Tamper with the cached value of the AVERAGE and check again.
    const zip = await JSZip.loadAsync(rendered.bytes);
    const sheet = await zip.file('xl/worksheets/sheet2.xml')!.async('string');
    expect(parseSheetCells(sheet).get('B4')?.formula).toBe('AVERAGE(B2:B3)');
    zip.file('xl/worksheets/sheet2.xml', sheet.replace('<f>AVERAGE(B2:B3)</f><v>30</v>', '<f>AVERAGE(B2:B3)</f><v>45</v>'));
    const tampered = await zip.generateAsync({ type: 'nodebuffer' });
    const bad = await checkDeliverable({ bytes: tampered, content: validated.value, claims: validated.claims, referenceOrder: rendered.referenceOrder, spec: SPEC, unmetNeeds: [] });
    expect(bad.passed).toBe(false);
    expect(bad.report.items.find((i) => i.code === 'FORMULAS_CALCULATE')?.passed).toBe(false);
  });

  it('opens a rendered document in a Word reader with every section, passage and source', async () => {
    const validated = await validateContent({ raw: writtenContent(), kind: 'WRITTEN', spec: SPEC, resolve: resolverFor(project.id) });
    if (!validated.ok || validated.value.kind !== 'WRITTEN') throw new Error('fixture invalid');
    const meta = { versionNumber: 1, generatedAt: new Date().toISOString(), projectName: 'Deal Dispatch', spec: SPEC, unmetNeeds: ['PDF rendering: not available'] };
    const rendered = renderDocx(validated.value.content, validated.claims, meta);
    const result = await checkDeliverable({ bytes: rendered.bytes, content: validated.value, claims: validated.claims, referenceOrder: rendered.referenceOrder, spec: SPEC, unmetNeeds: meta.unmetNeeds });
    expect(result.report.items.filter((i) => !i.passed)).toEqual([]);
    const text = (await mammoth.extractRawText({ buffer: rendered.bytes })).value;
    expect(text).toContain('Recording fees');
    expect(text).toContain(claims['Oakland']);
    expect(text).toContain('PDF rendering: not available');
  });

  it('refuses a review that passes a file with a major finding', () => {
    const r = validateReview(JSON.stringify({ verdict: 'PASS', summary: 's', findings: [{ severity: 'MAJOR', about: 'purpose', statement: 'x', repair: 'y' }], coverage: [{ requiredContent: 0, met: true, note: '' }, { requiredContent: 1, met: true, note: '' }] }), SPEC);
    expect(r.ok).toBe(false);
  });
});

describe('a deliverable, walked from a Russell turn to an opened file', () => {
  let server: Server | null = null;
  let base = '';

  beforeEach(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      attachContext(req, { principal: principal(), requestId: newRequestId(), method: req.method, path: req.path, remoteAddr: null, userAgent: null });
      next();
    });
    app.use('/api', deliverablesRouter);
    app.use((error: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(typeof error?.status === 'number' ? error.status : 500).json({ error: String(error?.message ?? error) });
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server!.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  it('builds, repairs, reviews, delivers, revises — and every version still opens', async () => {
    // 1. The person asks. A worker reading the thread proposes a deliverable.
    await asks('Please put together a short dossier comparing e-recording in Oakland and Wayne, as a PDF.', {
      action: 'REQUEST_DELIVERABLE',
      answer: 'I am building that dossier from the project’s evidence now.',
      deliverable: {
        title: 'Remote recording pilot: Oakland and Wayne',
        kind: 'WRITTEN',
        requestedFormat: 'PDF',
        intendedUse: SPEC.intendedUse,
        audience: SPEC.audience,
        requiredContents: SPEC.requiredContents,
        sourceRequirements: SPEC.sourceRequirements,
        acceptanceConditions: SPEC.acceptanceConditions,
        externalDelivery: null,
      },
    });
    const produced = (await listTurns(conversationId)).at(-1)!.produced;
    const id = produced['deliverableId'] as string;
    expect(id).toMatch(/^dlv_/);
    let d = (await getDeliverable(id))!;
    // The tick that applied the turn also opened the build, in the same pass.
    expect(d.state).toBe('BUILDING');
    // Asked for a PDF, Brain builds a verified DOCX and names the missing renderer.
    expect(d.format).toBe('DOCX');
    expect(d.needs.map((n) => n.capability)).toContain('PDF rendering');

    // 2. The builder submits a figure no claim states: refused while it holds the lease, then fixed.
    const builder = await newWorker('builder');
    const built = await answerBin({
      binId: d.activeBinId!,
      workerId: builder,
      sessionRef: 'cse_builder_1',
      unitKey: 'content',
      values: [writtenContent({ summary: [{ text: 'Oakland charges $31.50.', cites: [claims['Oakland']] }] }), writtenContent()],
    });
    expect(built.completed).toBe(true);
    expect(built.refusals[0]!.join(' ')).toMatch(/31\.5/);

    // 3. The tick renders, stores, checks and asks for a review.
    await advanceDeliverables();
    d = (await getDeliverable(id))!;
    expect(d.state).toBe('REVIEWING');
    let versions = await listVersions(id);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.status).toBe('CHECKED');

    // 4. The builder's own session may not review it.
    await answerBin({ binId: d.activeBinId!, workerId: builder, sessionRef: 'cse_builder_1', unitKey: 'review', values: [passingReview()] });
    await advanceDeliverables();
    d = (await getDeliverable(id))!;
    expect(d.state).toBe('REVIEWING');
    expect((await listFindings(id)).some((f) => f.code === 'REVIEW_REFUSED' && /made the change/.test(f.message))).toBe(true);

    // 5. A different session asks for a repair.
    const reviewer = await newWorker('reviewer');
    await answerBin({
      binId: d.activeBinId!,
      workerId: reviewer,
      sessionRef: 'cse_reviewer_1',
      unitKey: 'review',
      values: [JSON.stringify({
        verdict: 'REPAIR',
        summary: 'The fee comparison is there but the summary never says which county to start with.',
        findings: [{ severity: 'MAJOR', about: 'acceptance condition 0', statement: 'The summary does not answer the decision.', repair: 'State in the summary that the evidence shows Oakland without the surcharge.' }],
        coverage: [{ requiredContent: 0, met: true, note: '' }, { requiredContent: 1, met: true, note: '' }],
      })],
    });
    await advanceDeliverables();
    d = (await getDeliverable(id))!;
    expect(d.state).toBe('BUILDING');
    expect(d.activeReason).toBe('REPAIR');
    expect(d.activeReasonDetail).toMatch(/does not answer the decision/);

    // 6. A new build repairs it; the reviewer passes it; it is delivered.
    const repairer = await newWorker('repairer');
    await answerBin({
      binId: d.activeBinId!,
      workerId: repairer,
      sessionRef: 'cse_repairer_1',
      unitKey: 'content',
      values: [writtenContent({ summary: [
        { text: 'Both counties accept electronic recording at $30.00 per document.', cites: [claims['Oakland'], claims['Wayne']] },
        { text: 'Oakland has no surcharge stated, while Wayne adds $4.00, so Oakland is the cheaper place to start.', cites: [claims['Oakland'], claims['Wayne']] },
      ] })],
    });
    await advanceDeliverables();
    d = (await getDeliverable(id))!;
    expect(d.state).toBe('REVIEWING');
    await answerBin({ binId: d.activeBinId!, workerId: reviewer, sessionRef: 'cse_reviewer_2', unitKey: 'review', values: [passingReview()] });
    await advanceDeliverables();
    d = (await getDeliverable(id))!;
    expect(d.state).toBe('DELIVERED');
    versions = await listVersions(id);
    expect(versions.map((v) => [v.versionNumber, v.status, v.reason])).toEqual([
      [1, 'REVIEW_FAILED', 'INITIAL'],
      [2, 'REVIEW_PASSED', 'REPAIR'],
    ]);
    expect(d.currentVersionId).toBe(versions[1]!.id);
    expect(versions[1]!.reviewIndependence).toBeTruthy();

    // 7. The delivery is a message in the original conversation, with a link that opens.
    const delivered = (await listTurns(conversationId)).find((t) => t.produced['effect'] === 'DELIVERABLE_DELIVERED');
    expect(delivered?.content).toMatch(/is ready — version 2/);
    expect(delivered?.content).toMatch(/PDF rendering/);
    const link = delivered!.produced['fileUrl'] as string;
    const response = await fetch(`${base}${link}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toMatch(/attachment/);
    const bytes = Buffer.from(await response.arrayBuffer());
    const text = (await mammoth.extractRawText({ buffer: bytes })).value;
    expect(text).toContain('Oakland is the cheaper place to start');

    // 8. The person asks for a revision in the same conversation.
    await asks('Change the dossier to add a sentence saying only two counties are covered so far.', {
      action: 'REQUEST_DELIVERABLE',
      answer: 'Revising the dossier.',
      deliverable: { revisionOf: id, correction: 'Add a sentence to the summary saying only two counties are covered so far.' },
    });
    d = (await getDeliverable(id))!;
    expect(d.state).toBe('BUILDING');
    expect(d.activeReason).toBe('REVISION');
    await answerBin({
      binId: d.activeBinId!,
      workerId: repairer,
      sessionRef: 'cse_repairer_2',
      unitKey: 'content',
      values: [writtenContent({ summary: [
        { text: 'Oakland has no surcharge stated, while Wayne adds $4.00, so Oakland is the cheaper place to start.', cites: [claims['Oakland'], claims['Wayne']] },
        { text: 'Only two counties are covered so far.', framing: true },
      ] })],
    });
    await advanceDeliverables();
    d = (await getDeliverable(id))!;
    await answerBin({ binId: d.activeBinId!, workerId: reviewer, sessionRef: 'cse_reviewer_3', unitKey: 'review', values: [passingReview()] });
    await advanceDeliverables();
    d = (await getDeliverable(id))!;
    expect(d.state).toBe('DELIVERED');
    versions = await listVersions(id);
    expect(versions).toHaveLength(3);
    expect(d.currentVersionId).toBe(versions[2]!.id);
    expect(versions[2]!.reason).toBe('REVISION');

    // Every version still opens, and the current one is unambiguous.
    for (const v of versions) {
      const r = await fetch(`${base}/api/deliverables/${id}/versions/${v.versionNumber}/file`);
      expect(r.status).toBe(200);
      expect(r.headers.get('x-brain-file-sha256')).toBe(v.fileHash);
    }
    const current = await fetch(`${base}/api/deliverables/${id}/file`);
    expect(current.headers.get('x-brain-file-sha256')).toBe(versions[2]!.fileHash);
    const view = (await (await fetch(`${base}/api/deliverables/${id}`)).json()) as { deliverable: { current: { versionNumber: number }; versions: unknown[] } };
    expect(view.deliverable.current.versionNumber).toBe(3);
    const listed = (await (await fetch(`${base}/api/projects/${project.id}/deliverables`)).json()) as { deliverables: Array<{ id: string }> };
    expect(listed.deliverables.map((x) => x.id)).toContain(id);

    const messages = (await listTurns(conversationId)).filter((t) => t.produced['effect'] === 'DELIVERABLE_DELIVERED');
    expect(messages).toHaveLength(2);
    expect(messages[1]!.content).toMatch(/replaces version 2/);
  });

  it('declines a remark that names no output, and refuses to invent a project', async () => {
    await asks('I wonder how recording works in general.', {
      action: 'REQUEST_DELIVERABLE',
      answer: 'Building.',
      deliverable: {
        title: 'Recording', kind: 'WRITTEN', requestedFormat: null, intendedUse: 'x', audience: 'y',
        requiredContents: ['z'], sourceRequirements: 'w', acceptanceConditions: ['v'], externalDelivery: null,
      },
    });
    const produced = (await listTurns(conversationId)).at(-1)!.produced;
    expect(produced['deliverableDeclined']).toBe(true);
    expect(produced['gateReason']).toBe('NOT_A_DELIVERABLE_REQUEST');
  });
});
