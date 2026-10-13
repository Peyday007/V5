/**
 * WS-D: Cash, monetization and kernel progress (RES-2, -3, -4, -5, -6).
 *
 * Driven through the normal entry points — each kernel's own absorb/file pass,
 * `harvest`, `enumeratePossibilities`, `allocateCommissions` over a composed
 * ledger, `proposeTerms`/`applyProposal`, and `openDiscovery` — so what is
 * proven is what the tick does rather than what a helper would do if anything
 * called it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { createCandidate } from '../server/repos/russellCandidates.ts';
import { launchMission } from '../server/repos/russellMissions.ts';
import { roundOutcome } from '../server/services/russell/roundMissions.ts';
import { createOpportunity, getOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { raiseNeed } from '../server/services/cash/needs.ts';
import { questionKey } from '../server/services/cash/conditions.ts';
import type { CashOpportunity, MissionState, OpportunitySignal, RussellMission } from '../server/domain/types.ts';

let projectId = '';
let userId = '';
let cashModeId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const user = await createUser({
    email: `wsd-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
    isBrainAdmin: true,
  });
  userId = user.id;
  const started = await activate({
    projectId,
    ownerUserId: userId,
    actorUserId: userId,
    objective: 'Maximize additional usable cash over the next few weeks.',
  });
  expect(started.ok).toBe(true);
  cashModeId = (await getCashMode(projectId))!.id;
});

let seq = 0;
async function idea(title = 'A kernel question'): Promise<string> {
  seq += 1;
  const candidate = await createCandidate({
    projectId,
    visibility: 'SHARED',
    conversationId: null,
    sourceMessageId: null,
    title: `${title} ${seq}`,
    statement: `${title} ${seq}: what do the published sources say?`,
  });
  return candidate.id;
}

/** A mission for this idea, put in a state, and dated `ageMinutes` ago. */
async function mission(
  candidateId: string,
  state: MissionState,
  options: { attempt?: number; ageMinutes?: number } = {},
): Promise<RussellMission> {
  seq += 1;
  const { mission: row } = await launchMission({
    projectId,
    visibility: 'SHARED',
    objective: 'o',
    whyNow: 'w',
    idempotencyKey: `wsd-${candidateId}-${seq}`,
    candidateId,
    attempt: options.attempt ?? 1,
  });
  const at = new Date(Date.now() - (options.ageMinutes ?? 0) * 60_000).toISOString();
  await getDb().run(
    'UPDATE russell_missions SET state = ?, created_at = ?, updated_at = ? WHERE id = ?',
    [state, at, at, row.id],
  );
  return { ...row, state };
}

/**
 * Push one mission out of the newest-hundred window `listMissions` reads, by
 * writing a hundred and twenty newer ones for other ideas.
 */
async function buryUnderNewerMissions(): Promise<void> {
  for (let i = 0; i < 120; i += 1) {
    await mission(await idea('filler'), 'RUNNING', { ageMinutes: 0 });
  }
}

// ---------------------------------------------------------------------------
// RES-2 — the rule
// ---------------------------------------------------------------------------

describe('RES-2: a round settles on its own idea\'s latest mission, read by key', () => {
  const stub = (state: MissionState) => ({ state }) as RussellMission;
  it('DONE is HARVESTED, FAILED and CANCELLED are ABANDONED', () => {
    expect(roundOutcome({ latest: stub('DONE'), candidateState: 'QUEUED' })).toBe('HARVESTED');
    expect(roundOutcome({ latest: stub('FAILED'), candidateState: 'QUEUED' })).toBe('ABANDONED');
    expect(roundOutcome({ latest: stub('CANCELLED'), candidateState: 'QUEUED' })).toBe('ABANDONED');
  });
  it('preserves in-progress and person-waiting states, and never reads an absence as failure', () => {
    for (const state of ['PLANNED', 'LAUNCHING', 'RUNNING', 'WAITING', 'NEEDS_HUMAN'] as const) {
      expect(roundOutcome({ latest: stub(state), candidateState: 'QUEUED' })).toBeNull();
    }
    expect(roundOutcome({ latest: null, candidateState: 'QUEUED' })).toBeNull();
    expect(roundOutcome({ latest: null, candidateState: 'PARKED' })).toBeNull();
    expect(roundOutcome({ latest: null, candidateState: null })).toBeNull();
    // The archive already answered it: a positive terminal row, nothing will launch.
    expect(roundOutcome({ latest: null, candidateState: 'REJECTED' })).toBe('ABANDONED');
  });
});

// ---------------------------------------------------------------------------
// RES-2 — through each kernel's own pass, with the mission outside the window
// ---------------------------------------------------------------------------

describe('RES-2: dealflow', () => {
  async function round(candidateId: string) {
    const { openDealRound } = await import('../server/repos/dealflow.ts');
    return (
      await openDealRound({
        projectId,
        cashModeId,
        purpose: 'SEED_EQUIPMENT',
        round: 1,
        candidateId,
      })
    ).round;
  }

  it('a FAILED mission outside the newest hundred abandons the round, once, and frees the slot', async () => {
    const { fileFindings } = await import('../server/services/dealflow/expand.ts');
    const { openDealRoundsByCandidate } = await import('../server/repos/dealflow.ts');
    const candidateId = await idea();
    const opened = await round(candidateId);
    await mission(candidateId, 'FAILED', { ageMinutes: 600 });
    await buryUnderNewerMissions();

    const first = await fileFindings({ projectId });
    expect(first.settled.map((one) => one.roundId)).toEqual([opened.id]);
    const row = await getDb().get<{ state: string; found: number }>(
      'SELECT state, found FROM deal_rounds WHERE id = ?',
      [opened.id],
    );
    expect(row).toMatchObject({ state: 'ABANDONED', found: 0 });
    expect((await openDealRoundsByCandidate(projectId)).has(candidateId)).toBe(false);

    // A repeated tick and a restart settle nothing twice.
    expect((await fileFindings({ projectId })).settled).toEqual([]);
  });

  it('a DONE mission settles SETTLED; a RUNNING one stays OPEN', async () => {
    const { fileFindings } = await import('../server/services/dealflow/expand.ts');
    const done = await idea();
    const running = await idea();
    const a = await round(done);
    await mission(done, 'DONE', { ageMinutes: 600 });
    const { openDealRound } = await import('../server/repos/dealflow.ts');
    const b = (
      await openDealRound({
        projectId,
        cashModeId,
        purpose: 'DEMAND',
        equipmentClass: 'Tank trailers',
        round: 1,
        candidateId: running,
      })
    ).round;
    await mission(running, 'RUNNING', { ageMinutes: 600 });
    await buryUnderNewerMissions();

    await fileFindings({ projectId });
    const states = await getDb().all<{ id: string; state: string }>(
      'SELECT id, state FROM deal_rounds WHERE id IN (?, ?)',
      [a.id, b.id],
    );
    expect(Object.fromEntries(states.map((one) => [one.id, one.state]))).toEqual({
      [a.id]: 'SETTLED',
      [b.id]: 'OPEN',
    });
  });

  it('the latest attempt decides: an earlier FAILED beside a RUNNING redo keeps the round OPEN', async () => {
    const { fileFindings } = await import('../server/services/dealflow/expand.ts');
    const candidateId = await idea();
    const opened = await round(candidateId);
    await mission(candidateId, 'FAILED', { attempt: 1, ageMinutes: 900 });
    await mission(candidateId, 'RUNNING', { attempt: 2, ageMinutes: 800 });
    await fileFindings({ projectId });
    const row = await getDb().get<{ state: string }>('SELECT state FROM deal_rounds WHERE id = ?', [
      opened.id,
    ]);
    expect(row?.state).toBe('OPEN');
  });
});

describe('RES-2: industry, manufacturing and puzzle', () => {
  it('industry: CANCELLED outside the window abandons; DONE harvests', async () => {
    const { seedSubject } = await import('../server/services/industry/seed.ts');
    const { openIndustryRound } = await import('../server/repos/industry.ts');
    const { absorb } = await import('../server/services/industry/expand.ts');
    const seed = await seedSubject({ projectId, name: 'A sector', actorRef: userId });
    const cancelled = await idea();
    const done = await idea();
    const a = await openIndustryRound({
      projectId,
      cashModeId,
      nodeId: seed.node.id,
      purpose: 'MAP',
      bucketId: null,
      opportunityId: null,
      round: 1,
      candidateId: cancelled,
    });
    const b = await openIndustryRound({
      projectId,
      cashModeId,
      nodeId: seed.node.id,
      purpose: 'MAP',
      bucketId: null,
      opportunityId: null,
      round: 2,
      candidateId: done,
    });
    await mission(cancelled, 'CANCELLED', { ageMinutes: 600 });
    await mission(done, 'DONE', { ageMinutes: 600 });
    await buryUnderNewerMissions();

    const out = await absorb({ projectId });
    expect(out.settled.map((one) => one.roundId).sort()).toEqual(
      [a.round.id, b.round.id].sort(),
    );
    const rows = await getDb().all<{ id: string; state: string }>(
      'SELECT id, state FROM industry_rounds WHERE id IN (?, ?)',
      [a.round.id, b.round.id],
    );
    expect(Object.fromEntries(rows.map((one) => [one.id, one.state]))).toEqual({
      [a.round.id]: 'ABANDONED',
      [b.round.id]: 'HARVESTED',
    });
    expect((await absorb({ projectId })).settled).toEqual([]);
  });

  it('manufacturing: FAILED outside the window abandons the round', async () => {
    const { startProgramme } = await import('../server/services/manufacturing/program.ts');
    const { getProgram, openManufacturingRound } = await import('../server/repos/manufacturing.ts');
    const { absorb } = await import('../server/services/manufacturing/expand.ts');
    const started = await startProgramme({
      projectId,
      ownerUserId: userId,
      actorUserId: userId,
      objective:
        'Build a durable manufacturing company by entering the machine categories buyers are ' +
        'already purchasing, in an order the evidence supports.',
    });
    expect(started.ok).toBe(true);
    const program = (await getProgram(projectId))!;
    const candidateId = await idea();
    const opened = await openManufacturingRound({
      programId: program.id,
      projectId,
      categoryId: null,
      purpose: 'BOOTSTRAP',
      round: 1,
      candidateId,
    });
    await mission(candidateId, 'FAILED', { ageMinutes: 600 });
    await buryUnderNewerMissions();
    const out = await absorb({ projectId });
    expect(out.settled.map((one) => one.roundId)).toEqual([opened.round.id]);
    const row = await getDb().get<{ state: string }>(
      'SELECT state FROM manufacturing_rounds WHERE id = ?',
      [opened.round.id],
    );
    expect(row?.state).toBe('ABANDONED');
  });

  it('puzzle: FAILED outside the window abandons, and an ABANDONED round counts toward the cool-off', async () => {
    const { openPuzzleRound, listPuzzleRounds } = await import('../server/repos/puzzle.ts');
    const { filePuzzleFindings: fileFindings } = await import('../server/services/puzzle/expand.ts');
    const candidateId = await idea();
    const opened = await openPuzzleRound({
      projectId,
      cashModeId,
      purpose: 'SEED_FORMATS',
      formatKey: null,
      productClass: null,
      candidateId,
      round: 1,
    });
    await mission(candidateId, 'FAILED', { ageMinutes: 600 });
    await buryUnderNewerMissions();
    const out = await fileFindings({ projectId });
    expect(out.settled.map((one) => one.roundId)).toEqual([opened.round.id]);
    const rounds = await listPuzzleRounds(projectId);
    expect(rounds[0]).toMatchObject({ state: 'ABANDONED', found: 0 });
    expect(rounds[0]!.settledAt).not.toBeNull();
    expect((await fileFindings({ projectId })).settled).toEqual([]);
  });
});

describe('RES-2: labor settles by key too', () => {
  async function laborRound(candidateId: string) {
    const { createWorkflow, createTask, openLaborRound } = await import('../server/repos/labor.ts');
    seq += 1;
    const { workflow } = await createWorkflow({ projectId, name: `labor flow ${seq}`, origin: 'SEED' });
    const { task } = await createTask({
      projectId,
      workflowId: workflow.id,
      name: `labor task ${seq}`,
      output: 'a delivered report',
      origin: 'SEED',
    });
    return (await openLaborRound({ projectId, taskId: task.id, purpose: 'NECESSITY', round: 1, candidateId })).round;
  }

  it('a FAILED mission outside the newest hundred abandons the labor round once; a RUNNING one stays OPEN', async () => {
    const { absorb } = await import('../server/services/labor/expand.ts');
    const failed = await idea();
    const running = await idea();
    const ended = await laborRound(failed);
    const live = await laborRound(running);
    await mission(failed, 'FAILED', { ageMinutes: 600 });
    await mission(running, 'RUNNING', { ageMinutes: 600 });
    await buryUnderNewerMissions();

    const first = await absorb({ projectId });
    expect(first.settled.map((one) => one.roundId)).toEqual([ended.id]);
    const rows = await getDb().all<{ id: string; state: string }>(
      'SELECT id, state FROM labor_rounds WHERE id IN (?, ?)',
      [ended.id, live.id],
    );
    expect(Object.fromEntries(rows.map((row) => [row.id, row.state]))).toEqual({
      [ended.id]: 'ABANDONED',
      [live.id]: 'OPEN',
    });
    expect((await absorb({ projectId })).settled).toEqual([]);
  });
});

describe('RES-2: cash discovery and answers find their missions by key', () => {
  it('harvest closes a discovery round whose FAILED mission is outside the window', async () => {
    const { openDiscovery, harvest } = await import('../server/services/cash/discovery.ts');
    const { listRounds } = await import('../server/repos/cashDiscovery.ts');
    const opened = await openDiscovery({ projectId, limit: 1 });
    expect(opened).toHaveLength(1);
    await mission(opened[0]!.candidateId, 'FAILED', { ageMinutes: 600 });
    await buryUnderNewerMissions();
    await harvest({ projectId });
    const round = (await listRounds(projectId)).find(
      (one) => one.candidateId === opened[0]!.candidateId,
    );
    expect(round?.state).toBe('ABANDONED');
  });

  it("assessResearch reports a need's DONE mission outside the window as finished, not never started", async () => {
    const { assessResearch } = await import('../server/services/cash/answers.ts');
    const opportunity = await opening('PAID_TASK_OR_CONTRACT', 'A published request for work.');
    const candidateId = await idea();
    const raised = await raiseNeed({
      projectId,
      opportunityId: opportunity.id,
      actorRef: 'BRAIN',
      blockedAction: 'Payer for it',
      whyItMatters: 'w',
      recommendedPath: 'r',
      setupEffort: 's',
      nextStep: 'n',
      completionCondition: 'The payer is recorded on this card.',
      candidateId,
      requestKey: questionKey(opportunity.id, 'payer'),
    });
    expect(raised.ok).toBe(true);
    await mission(candidateId, 'DONE', { ageMinutes: 600 });
    await buryUnderNewerMissions();
    const assessed = (await assessResearch(projectId)).find(
      (one) => one.need.candidateId === candidateId,
    );
    expect(assessed?.state).not.toBe('NEVER_STARTED');
  });
});

// ---------------------------------------------------------------------------
// RES-3 / RES-4 — the possibility ledger
// ---------------------------------------------------------------------------

async function opening(
  signal: OpportunitySignal,
  title: string,
  over: Record<string, unknown> = {},
): Promise<CashOpportunity> {
  const created = await createOpportunity({
    projectId,
    cashModeId,
    ownerUserId: userId,
    title,
    mechanism: 'EXPLICIT_PAID_REQUEST',
    currency: 'USD',
    opportunitySignal: signal,
    source: 'A publisher',
    ...over,
  });
  return (
    (await updateOpportunity(created.id, {
      buying_signal: title,
      signal_observed_at: '2026-09-15',
    })) ?? created
  );
}

describe('RES-3: a BLOCKED path is asked only what its blocker names', () => {
  async function plan() {
    const { enumeratePossibilities } = await import(
      '../server/services/cash/monetization/enumerate.ts'
    );
    const { composeLedger, rankableOf } = await import(
      '../server/services/cash/monetization/ledger.ts'
    );
    const { allocateCommissions } = await import(
      '../server/services/cash/monetization/commission.ts'
    );
    await enumeratePossibilities(projectId);
    const ledger = await composeLedger({ projectId });
    return {
      ledger,
      allocation: allocateCommissions({
        entries: ledger.entries,
        rankable: ledger.entries.map(rankableOf),
        commissions: [],
        contradicted: new Set(),
        slots: 50,
        now: Date.now(),
      }),
    };
  }

  it('a capability blocker admits requiredCapability and nothing else, never probabilityOfSuccess', async () => {
    const piece = await opening('PAID_TASK_OR_CONTRACT', 'A published request for transcription.');
    await raiseNeed({
      projectId,
      opportunityId: piece.id,
      actorRef: 'BRAIN',
      blockedAction: 'Contact the buyer',
      whyItMatters: 'w',
      recommendedPath: 'r',
      setupEffort: 's',
      nextStep: 'n',
      completionCondition: 'SEND_A_MESSAGE reads PRESENT.',
      requestKey: `capability:${piece.id}:SEND_A_MESSAGE`,
    });
    const { ledger, allocation } = await plan();
    expect(ledger.entries.every((one) => one.status === 'BLOCKED')).toBe(true);
    expect(allocation.asks.length).toBeGreaterThan(0);
    expect(allocation.asks.every((one) => one.attribute === 'requiredCapability')).toBe(true);
    expect(allocation.asks.some((one) => one.attribute === 'probabilityOfSuccess')).toBe(false);
    expect(
      allocation.declined.some((one) => one.why.includes('does not bear on what blocks it')),
    ).toBe(true);
  });

  it('a blocker already being researched by its own need asks nothing; resolving it lets the ordinary rules run', async () => {
    const piece = await opening('PAID_TASK_OR_CONTRACT', 'A published request for transcription.');
    const raised = await raiseNeed({
      projectId,
      opportunityId: piece.id,
      actorRef: 'BRAIN',
      blockedAction: 'Payer for it',
      whyItMatters: 'w',
      recommendedPath: 'r',
      setupEffort: 's',
      nextStep: 'n',
      completionCondition: 'The payer is recorded on this card.',
      candidateId: await idea(),
      requestKey: questionKey(piece.id, 'payer'),
    });
    expect(raised.ok).toBe(true);
    const blocked = await plan();
    expect(blocked.allocation.asks).toHaveLength(0);

    // The blocker goes; the allocator evaluates the next question by its own rules.
    await getDb().run("UPDATE cash_needs SET state = 'WITHDRAWN' WHERE id = ?", [
      raised.ok ? raised.value.id : '',
    ]);
    const freed = await plan();
    expect(freed.ledger.entries.some((one) => one.status === 'BLOCKED')).toBe(false);
    expect(freed.allocation.asks.length).toBeGreaterThan(0);
    expect(freed.allocation.asks.some((one) => one.attribute === 'probabilityOfSuccess')).toBe(
      false,
    );
  });
});

describe('RES-4: a duplicate opening has no space of its own', () => {
  it('stops enumerating a duplicate, points its existing paths at the primary, and undoes it when the link goes', async () => {
    const { enumeratePossibilities } = await import(
      '../server/services/cash/monetization/enumerate.ts'
    );
    const { listPaths } = await import('../server/repos/monetization.ts');
    const primary = await opening('ACTIVE_BUYER_DEMAND', 'An RFQ for certification services.');
    const second = await opening('ACTIVE_BUYER_DEMAND', 'The same RFQ, found again.');
    await enumeratePossibilities(projectId);
    const before = (await listPaths({ projectId })).filter((one) => one.opportunityId === second.id);
    expect(before.length).toBeGreaterThan(0);

    await getDb().run('UPDATE cash_opportunities SET duplicate_of_id = ? WHERE id = ?', [
      primary.id,
      second.id,
    ]);
    const report = await enumeratePossibilities(projectId);
    expect(report.mergedDuplicates.sort()).toEqual(before.map((one) => one.id).sort());
    const after = await listPaths({ projectId });
    const primaryByMethod = new Map(
      after.filter((one) => one.opportunityId === primary.id).map((one) => [one.method, one.id]),
    );
    for (const path of after.filter((one) => one.opportunityId === second.id)) {
      // Kept, pointed at the primary's path of the same method — never deleted.
      expect(path.mergedIntoId).toBe(primaryByMethod.get(path.method));
    }
    // Idempotent: a second pass merges nothing and adds no path to the duplicate.
    const again = await enumeratePossibilities(projectId);
    expect(again.mergedDuplicates).toEqual([]);
    expect(again.added.some((one) => one.opportunityId === second.id)).toBe(false);

    // The duplicate link undone (as releaseDuplicatesOfArchived does): Brain's merge reverses.
    await getDb().run('UPDATE cash_opportunities SET duplicate_of_id = NULL WHERE id = ?', [
      second.id,
    ]);
    await enumeratePossibilities(projectId);
    const restored = (await listPaths({ projectId })).filter(
      (one) => one.opportunityId === second.id,
    );
    expect(restored.every((one) => one.mergedIntoId === null)).toBe(true);
  });

  it('a merged duplicate path is never commissioned', async () => {
    const { enumeratePossibilities } = await import(
      '../server/services/cash/monetization/enumerate.ts'
    );
    const { composeLedger, rankableOf } = await import(
      '../server/services/cash/monetization/ledger.ts'
    );
    const { allocateCommissions } = await import(
      '../server/services/cash/monetization/commission.ts'
    );
    const primary = await opening('ACTIVE_BUYER_DEMAND', 'An RFQ for certification services.');
    const second = await opening('ACTIVE_BUYER_DEMAND', 'The same RFQ, found again.');
    await enumeratePossibilities(projectId);
    await getDb().run('UPDATE cash_opportunities SET duplicate_of_id = ? WHERE id = ?', [
      primary.id,
      second.id,
    ]);
    await enumeratePossibilities(projectId);
    const ledger = await composeLedger({ projectId });
    const plan = allocateCommissions({
      entries: ledger.entries,
      rankable: ledger.entries.map(rankableOf),
      commissions: [],
      contradicted: new Set(),
      slots: 50,
      now: Date.now(),
    });
    const secondPaths = new Set(
      ledger.entries.filter((one) => one.path.opportunityId === second.id).map((one) => one.path.id),
    );
    expect(plan.asks.some((one) => secondPaths.has(one.pathId))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RES-5 — canonical document identity, and held openings in the next question
// ---------------------------------------------------------------------------

describe('RES-5: one opening, however it was reached', () => {
  it('an index page and the document it names converge; unrelated documents stay apart', async () => {
    const { canonicalDocumentKey } = await import('../server/services/cash/duplicates.ts');
    const index = 'https://www.stlouis-mo.gov/sldc/procurement/';
    const doc = 'https://www.stlouis-mo.gov/sldc/procurement/rfq-mbe-wbe-certification.cfm';

    // The index claim's excerpt links to the document: same key as the document itself.
    expect(
      canonicalDocumentKey(index, {
        excerpt: `See ${doc} for the MBE/WBE certification RFQ.`,
      }),
    ).toBe(canonicalDocumentKey(doc));

    // One procurement reference, on one host, whichever page it was read on.
    const ref = { claim: 'NJDOH lists RFQ #09-11-26-39DPA for preventive services.' };
    expect(canonicalDocumentKey('https://nj.gov/health/bids/', ref)).toBe(
      canonicalDocumentKey('https://nj.gov/health/bids/rfq-0911.pdf', ref),
    );

    // Two different references on one listing page are two openings, not one.
    expect(
      canonicalDocumentKey('https://nj.gov/health/bids/', { claim: 'RFQ #09-11-26-39DPA is open.' }),
    ).not.toBe(
      canonicalDocumentKey('https://nj.gov/health/bids/', { claim: 'RFQ #10-02-26-11XYZ is open.' }),
    );
    // A shared publisher or index page with no evidence joins nothing new.
    expect(canonicalDocumentKey('https://nj.gov/health/bids/', { claim: 'A bid is open.' })).toBe(
      'nj.gov/health/bids',
    );
    // A link to another host is not evidence about this document.
    expect(
      canonicalDocumentKey(index, { excerpt: 'Mirrored at https://example.com/rfq.pdf' }),
    ).toBe(canonicalDocumentKey(index));
    // A year is not a reference.
    expect(canonicalDocumentKey(index, { claim: 'The 2026 Bid 2026 cycle.' })).toBe(
      canonicalDocumentKey(index),
    );
    // Two references in one claim are ambiguous, so the source key stands.
    expect(
      canonicalDocumentKey(index, { claim: 'RFQ #A-1001 and RFQ #A-1002 are both open.' }),
    ).toBe(canonicalDocumentKey(index));
  });

  it('markDuplicateOpenings links an index-page record to the document record', async () => {
    const { markDuplicateOpenings } = await import('../server/services/cash/duplicates.ts');
    const a = await claimedOpening('https://www.stlouis-mo.gov/sldc/procurement/rfq-mbe.cfm', null);
    const b = await claimedOpening(
      'https://www.stlouis-mo.gov/sldc/procurement/',
      'Listed: https://www.stlouis-mo.gov/sldc/procurement/rfq-mbe.cfm',
    );
    const c = await claimedOpening('https://www.stlouis-mo.gov/sldc/procurement/other-rfp.cfm', null);
    const marked = await markDuplicateOpenings(projectId);
    expect(marked).toEqual([b.id]);
    expect((await getOpportunity(b.id))?.duplicateOfId).toBe(a.id);
    expect((await getOpportunity(c.id))?.duplicateOfId).toBeNull();
  });

  it('the next bucket question names the openings already held, and asks for new revisions', async () => {
    const { questionFor, heldExclusions, SEARCH_BUCKETS } = await import(
      '../server/services/cash/discovery.ts'
    );
    const bucket = SEARCH_BUCKETS.find((one) => one.mechanism === 'EXPLICIT_PAID_REQUEST')!;
    await claimedOpening('https://www.stlouis-mo.gov/sldc/procurement/rfq-mbe.cfm', null, 'MBE WBE certification RFQ');
    await claimedOpening('https://example.org/jobs/42', null, 'Transcription for Ohio clinics, contact the office');
    const held = await heldExclusions({ projectId, bucket, history: [] });
    const question = questionFor(bucket, 'cash', 2, [], held);
    expect(question).toContain('stlouis-mo.gov/sldc/procurement/rfq-mbe.cfm');
    expect(question).toContain('materially new revision');
    // A title naming a state, or reading as Brain's own action, is never carried
    // into a question the compiler reads; the key alone stands in for it.
    expect(question).not.toMatch(/Ohio/);
    expect(question).toContain('example.org/jobs/42');
  });
});

describe('RES-5: the exclusions reach the compiled question and pass the envelope', () => {
  it('openDiscovery carries held openings into the candidate, and the compiler still specifies it', async () => {
    const { openDiscovery } = await import('../server/services/cash/discovery.ts');
    const { getCandidate } = await import('../server/repos/russellCandidates.ts');
    const { getProject } = await import('../server/repos/projects.ts');
    const { compileMission } = await import('../server/services/russell/compiler.ts');
    await claimedOpening(
      'https://www.stlouis-mo.gov/sldc/procurement/rfq-mbe.cfm',
      null,
      'MBE WBE certification consulting RFQ, purchase of services',
    );
    const opened = await openDiscovery({ projectId, limit: 1 });
    expect(opened).toHaveLength(1);
    const candidate = (await getCandidate(opened[0]!.candidateId))!;
    expect(candidate.statement).toContain('stlouis-mo.gov/sldc/procurement/rfq-mbe.cfm');
    const compiled = await compileMission({
      candidate,
      project: (await getProject(projectId))!,
      archive: { claimsConsidered: 0, contradicting: [] },
    });
    expect(compiled.ok).toBe(true);
    if (compiled.ok) {
      expect(compiled.mission.fragments[0]!.question).toContain('already listed');
    }
  });
});

async function claimedOpening(
  sourceUrl: string,
  excerpt: string | null,
  title = 'An open RFQ',
): Promise<CashOpportunity> {
  const { listLayers } = await import('../server/repos/layers.ts');
  const { createRun } = await import('../server/repos/runs.ts');
  const { createOrchestration, createFragments, insertClaims } = await import(
    '../server/repos/research.ts'
  );
  const layer = (await listLayers(projectId))[0]!;
  const run = await createRun({
    projectId,
    layerId: layer.id,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: 'p',
  });
  const orchestration = await createOrchestration({
    projectId,
    layerId: layer.id,
    runId: run.id,
    title: 't',
    assignment: 'a',
    provider: 'WORKER',
    autoApprove: false,
  });
  const [fragment] = await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId,
      layerId: layer.id,
      fragmentIndex: 0,
      fragmentKey: 'k',
      question: 'q',
      geography: 'United States',
      requiredEvidence: [{ id: 'demand', description: 'd', necessity: 'REQUIRED', minSources: 1 }],
      acceptableSourceTypes: ['primary'],
      excludedSourceTypes: [],
      completionCriteria: ['c'],
      dependsOn: [],
      minIndependentSources: 1,
    } as never,
  ]);
  seq += 1;
  const [claim] = await insertClaims([
    {
      orchestrationId: orchestration.id,
      fragmentId: fragment!.id,
      passId: null,
      passKey: 'TARGETED',
      claim: `${title} ${seq}`,
      sourceUrl,
      sourceTitle: 'A procurement page',
      sourcePublisher: 'A publisher',
      sourceDate: '2026-09-15',
      evidenceExcerpt: excerpt,
      evidenceLocator: 'the page',
      evidenceLane: 'demand',
      retrievedAt: '2026-09-15T00:00:00.000Z',
      confidence: 0.9,
      validationState: 'SOURCED',
      validationDetail: null,
      sourced: true,
      accepted: true,
      claimType: 'SOURCED_FACT',
      contentHash: `${seq}`.padStart(64, 'c'),
    } as never,
  ]);
  const created = await createOpportunity({
    projectId,
    cashModeId,
    ownerUserId: userId,
    title: `${title} ${seq}`,
    mechanism: 'EXPLICIT_PAID_REQUEST',
    currency: 'USD',
    opportunitySignal: 'ACTIVE_BUYER_DEMAND',
    source: 'A publisher',
    sourceClaimId: claim!.id,
  });
  return created!;
}

// ---------------------------------------------------------------------------
// RES-6 — delivery and fulfilment from what delivering actually needs
// ---------------------------------------------------------------------------

describe('RES-6: being able to research is not being able to deliver', () => {
  it('withholds delivery and fulfilment when nothing records what delivering needs', async () => {
    const { proposeTerms } = await import('../server/services/cash/answers.ts');
    const piece = await opening('PAID_TASK_OR_CONTRACT', 'Haul gravel to a job site.');
    const proposal = await proposeTerms(piece);
    expect(proposal.terms.map((one) => one.field)).not.toContain('delivery');
    expect(proposal.terms.map((one) => one.field)).not.toContain('fulfillment');
    expect(proposal.withheld.find((one) => one.field === 'fulfillment')?.because).toMatch(
      /not evidence it can produce/,
    );
  });

  it('withholds for a physical deliverable even when every capability reads present', async () => {
    const { proposeTerms } = await import('../server/services/cash/answers.ts');
    const { createWorkflow, createTask, recordAllocation } = await import(
      '../server/repos/labor.ts'
    );
    const piece = await opening('PAID_TASK_OR_CONTRACT', 'Supply Christmas trees.', {
      requiredCapabilities: [],
    });
    const { workflow } = await createWorkflow({
      projectId,
      name: 'Delivering: trees',
      description: 'd',
      origin: 'SEED',
      opportunityId: piece.id,
    });
    const { task } = await createTask({
      projectId,
      workflowId: workflow.id,
      name: 'Deliver the trees',
      output: 'Trees on site',
      origin: 'SEED',
    });
    await recordAllocation({
      projectId,
      taskId: task.id,
      productionLayer: 'PHYSICAL_OPERATOR',
      necessityReason: 'PHYSICAL_EXECUTION',
      decidedBy: 'PERSON',
      decidedByRef: userId,
      rationale: 'Trees have to be moved by somebody.',
    } as never);
    const proposal = await proposeTerms(piece);
    expect(proposal.terms.map((one) => one.field)).not.toContain('fulfillment');
    expect(proposal.withheld.find((one) => one.field === 'fulfillment')?.because).toMatch(
      /physical work/,
    );
  });

  it('withdraws the old research-only proposal, guarded on its exact text, once', async () => {
    const { proposeTerms, applyProposal } = await import('../server/services/cash/answers.ts');
    const { recordCardFact, cardFact } = await import('../server/repos/cashCardFacts.ts');
    const piece = await opening('PAID_TASK_OR_CONTRACT', 'Haul gravel to a job site.');
    await updateOpportunity(piece.id, { fulfillment_owner: 'Brain, with a person reviewing' });
    await recordCardFact({
      projectId,
      opportunityId: piece.id,
      field: 'fulfillment',
      kind: 'RECOMMENDATION',
      value: 'Brain, with a person reviewing',
      basis: 'Follows from the delivery path above.',
      assumptions: 'a',
      uncertainty: 'u',
      decidedBy: 'BRAIN',
    } as never);
    const fresh = (await getOpportunity(piece.id))!;
    await applyProposal({ opportunity: fresh, proposal: await proposeTerms(fresh) });
    expect(await cardFact(piece.id, 'fulfillment')).toBeNull();
    expect((await getOpportunity(piece.id))?.fulfillmentOwner).toBeNull();
    const events = await getDb().all<{ n: number }>(
      "SELECT COUNT(*) AS n FROM cash_events WHERE opportunity_id = ? AND kind = 'CASH_TERMS_WITHDRAWN'",
      [piece.id],
    );
    expect(Number(events[0]?.n)).toBe(1);
    const again = (await getOpportunity(piece.id))!;
    await applyProposal({ opportunity: again, proposal: await proposeTerms(again) });
    const after = await getDb().all<{ n: number }>(
      "SELECT COUNT(*) AS n FROM cash_events WHERE opportunity_id = ? AND kind = 'CASH_TERMS_WITHDRAWN'",
      [piece.id],
    );
    expect(Number(after[0]?.n)).toBe(1);
  });

  it("never withdraws a person's answer", async () => {
    const { proposeTerms, applyProposal } = await import('../server/services/cash/answers.ts');
    const { recordCardFact, cardFact } = await import('../server/repos/cashCardFacts.ts');
    const piece = await opening('PAID_TASK_OR_CONTRACT', 'Haul gravel to a job site.');
    await recordCardFact({
      projectId,
      opportunityId: piece.id,
      field: 'fulfillment',
      kind: 'PERSON',
      value: 'Brain, with a person reviewing',
      decidedBy: userId,
    } as never);
    await applyProposal({ opportunity: piece, proposal: await proposeTerms(piece) });
    expect((await cardFact(piece.id, 'fulfillment'))?.kind).toBe('PERSON');
  });
});


// ---------------------------------------------------------------------------
// RES-12 a/b/d — the cash report, run as the script the workflow runs
// ---------------------------------------------------------------------------

describe.skipIf(Boolean((process.env.BRAIN_TEST_DATABASE_URL ?? '').trim()))(
  'RES-12: the cash report counts completely, prints the ledger and the real park reason',
  () => {
    it('totals past the old 100/500 windows, a labelled sample, the ledger, and the park reason', async () => {
      const { execFileSync } = await import('node:child_process');
      const { recordMoney } = await import('../server/repos/cashLedger.ts');

      for (let i = 0; i < 130; i += 1) await mission(await idea('busy'), 'FAILED');
      // A parked mission's reason lives in waiting_on, not terminal_reason (RES-9).
      // The schema already refuses a parked mission with no waiting_on, so the
      // "(no reason recorded)" lines were the report reading the wrong column.
      const waiting = await mission(await idea('waiting'), 'RUNNING');
      await getDb().run(
        `UPDATE russell_missions SET state = 'NEEDS_HUMAN', waiting_on = ?, terminal_reason = NULL WHERE id = ?`,
        ['No fragment cleared its evidence gate; the standing authority has expired', waiting.id],
      );
      const refusal = 'the question names Missouri and Ohio, and splitting it is not Brain\'s call';
      const parked = await idea('parked');
      await getDb().run(
        `UPDATE russell_candidates SET state = 'PARKED', priority = 'PARKED',
            reason = 'this depends on something, which is not ready',
            judgment = ? WHERE id = ?`,
        [JSON.stringify({ decidedBy: 'COMPILER', refusal }), parked],
      );
      for (const [kind, cents, key] of [
        ['CAPITAL_IN', 50_000, 'cap'],
        ['COST', 1_250, 'cost'],
      ] as const) {
        const written = await recordMoney({
          projectId,
          kind,
          amountCents: cents,
          currency: 'USD',
          recordedBy: userId,
          idempotencyKey: `report-${key}`,
        });
        expect(written.ok).toBe(true);
      }

      const output = execFileSync(
        process.execPath,
        ['--import', 'tsx', 'scripts/cash-report.ts', '--project', projectId],
        {
          // This file's own SQLite database, which `freshProject` names per test.
          env: {
            ...process.env,
            BRAIN_DB_PATH: (
              await getDb().all<{ file: string }>('PRAGMA database_list')
            ).find((one) => one.file)!.file,
          },
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
        },
      );
      const missions = Number((await getDb().get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM russell_missions WHERE project_id = ?',
        [projectId],
      ))!.n);
      const ideas = Number((await getDb().get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM russell_candidates WHERE project_id = ?',
        [projectId],
      ))!.n);
      expect(missions).toBeGreaterThan(100);
      expect(output).toContain(`  missions    ${missions} — `);
      expect(output).toContain(`IDEAS (${ideas}) — `);
      expect(output).toMatch(/PARKED — showing 1 of 1/);
      expect(output).toContain(`compiler refusal: ${refusal}`);
      expect(output).toContain('MONEY LEDGER (USD)');
      expect(output).toMatch(/available funds\s+487\.50/);
      expect(output).toMatch(/by kind\s+CAPITAL_IN=500\.00 COST=12\.50/);
      expect(output).toContain(`missions=${missions}`);
      expect(output).toMatch(/NEEDS_HUMAN\s+No fragment cleared its evidence gate; the standing authority has expired/);
      expect(output).toContain('GATE OUTCOMES (fragments judged ');
      // Session F's accounting reads print as sections, and none collapsed.
      expect(output).toContain('STALE RESEARCH WORK');
      expect(output).toContain("MISSIONS FAILED 'left RESEARCHING with nothing queued'");
      expect(output).toContain('SOURCE ACCESS BLOCKS by Routine');
      expect(output).not.toContain('(could not be read');
      expect(output).toContain('CASH-REPORT: OK');
    }, 120_000);
  },
);
