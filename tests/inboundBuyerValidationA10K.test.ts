/**
 * Inbound buyer validation for the $10K plan class
 * (OPERATOR:MISSING_CAPABILITY:aed45eeb30f0ec42).
 *
 * The operator asked (run opr_99026b0ef4c04df9b03d): which inbound mechanism can
 * move a $10K PA Farm Vitality / home-improvement opening to D_BUYER_VALIDATED
 * without direct outreach, paid spend, automated research or Factory engineering,
 * and what is the minimal implementation on Brain's existing capabilities?
 *
 * The answer this file records and pins, each claim with its source:
 *
 *  1. Only a money-committed inbound signal can count as conversion. The
 *     landing-page (smoke) test is one plain page for the offer — headline, 2-3
 *     benefits, one call to action — whose CTA commitment level is chosen before
 *     launch (email signup/waitlist lowest, a simulated "buy now" medium, a real
 *     pre-order highest), with a success threshold fixed before launch and
 *     conversion = CTA completions / unique visitors, at least ~200 unique visitors
 *     for a directional read.
 *     https://kromatic.com/real-startup-book/landing-page-smoke-test
 *  2. A click, signup or fake-door "buy now" does not establish purchase: no
 *     published study measures how well smoke-test signals predict later purchase,
 *     and the practitioner guides themselves say a signup overstates willingness to
 *     pay. So those are recorded as interest, never fed in as a close rate.
 *     https://kromatic.com/real-startup-book/landing-page-smoke-test
 *  3. All-or-nothing reward crowdfunding needs no up-front spend (the platform
 *     takes 5% only of successfully raised funds), and money-committed pledges
 *     separate offers sharply: funded projects median pledge ratio 1.13 and ~202
 *     backers, unfunded 0.04 and ~22 (Kickstarter 2009-2014).
 *     https://conference.iza.org/conference_files/EntreRes2015/xu_t22362.pdf
 *  4. A pledge count partly measures the founder's own network (log Facebook
 *     friends predicts success in 48,526 projects), so with no outreach and no paid
 *     promotion the read depends on organic reach and is a caveat on the count,
 *     not a reason to discount it silently.
 *     https://leeds-faculty.colorado.edu/bhagat/Dynamics-of-Crowdfunding.pdf
 *  5. The concierge test is excluded: as canonically described it recruits its
 *     3-5 early adopters by direct outreach.
 *     https://kromatic.com/real-startup-book/concierge-test
 *
 * Minimal implementation on what Brain already has: a real pre-order / deposit
 * CTA (or an all-or-nothing pledge page) whose paid commitments are counted
 * against unique visitors and recorded through `measuredRateInput`, the same
 * shape the reply record uses. That reaches `conversionState` HISTORICAL, the
 * CONVERSION link holds, and `validationStage` reads D_BUYER_VALIDATED. No new
 * mechanism is needed, and the gate is unchanged: an assumed rate, an unsized
 * rate, or an interest-only signal stays NONE.
 *
 * The failure class: a question the operator asked (`commissionResearch` with no
 * goal — a causeless MISSING_CAPABILITY Brain holds no answer to) was carried by
 * §87's loop through method research and then on to Factory as an engineering
 * objective, as if the answer were code. A question now carries
 * `directive.question`, and once its method research settles the loop closes it
 * (`questionClosure`) instead of opening a Factory objective; older rows of the
 * same shape are recognised too. The inventory finding is also not re-offered
 * while its repair is in flight or after the repair was rejected. Nothing here
 * lowers a bar.
 *
 * Where the answer lives: not in this comment. When the loop closes a question it
 * records the answer on the decision itself — `questionAnswer` gathers every
 * accepted research claim and archive claim with its source, the DECIDED event
 * carries them (`answer`, `researchGoalId`, `askedIn`, `questionText`) and the
 * candidate's decision reason lists them with their sources — so the operator run
 * whose decision waited on the question reads and cites the register row. The
 * claims above are this file's fixtures and expectations, not the record.
 *
 * The production change is `questionClosure` in the loop's DIAGNOSE/ENGINEER
 * step (server/services/improvement/loop.ts) and `question: true` on the
 * directive `commissionResearch` writes (server/services/operator/director.ts).
 * The last describe block drives that real step, `advanceNow`, over the
 * commissioned row with its method research settled. Without the change the
 * step went on to reuse search and a Factory objective, and the row stayed
 * open; with it, the row closes as a question and no change request exists.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { decideCandidate, getCandidate, listImprovementEvents, patchCandidate, upsertCandidate } from '../server/repos/improvement.ts';
import { createProject, getProjectBySlug } from '../server/repos/projects.ts';
import { createLayer } from '../server/repos/layers.ts';
import { getDb } from '../server/db/database.ts';
import { createGoal } from '../server/repos/russellAuthority.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, currentFragments, decideClaim, insertClaims, updateFragment } from '../server/repos/research.ts';
import { setImprovementSwitch } from '../server/services/improvement/authority.ts';
import { advanceNow, isResearchQuestion, questionAnswer, questionClosure, questionDecisionReason } from '../server/services/improvement/loop.ts';
import type { Linked } from '../server/services/improvement/loop.ts';
import { getInventoryItem, upsertInventory } from '../server/services/operator/inventory.ts';
import { commission, commissionResearch, inventoryDeficiencies, readingId } from '../server/services/operator/director.ts';
import { inputEvidence, measuredRateInput } from '../server/services/goals/portfolio.ts';
import { conversionState, validationStage } from '../server/services/goals/plan.ts';
import type { LinkCheck } from '../server/services/goals/plan.ts';
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';
import { modelOpportunity, readInboundCommitments } from '../server/services/cash/goalScenario.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { createOpportunity } from '../server/repos/cashPortfolio.ts';
import { getCashMode } from '../server/repos/cashMode.ts';
import { activate } from '../server/services/cash/lifecycle.ts';

const uid = () => Math.random().toString(36).slice(2, 8);
const ctx = { runId: 'opr_99026b0ef4c04df9b03d', actor: 'test' };
const fixed = (value: number): ModelInput => ({ value, low: value, high: value, provenance: 'EVIDENCE', source: null, note: '' });

function opening(close: ModelInput): ModelledOpportunity {
  return {
    opportunity: { id: 'cop_inbound', title: 'PA Farm Vitality home-improvement plan', projectId: 'p', offerScope: 'plan', payer: 'homeowner', requiredCapabilities: [] } as unknown as ModelledOpportunity['opportunity'],
    index: 1,
    tier: 'QUALIFIED',
    repeatable: true,
    price: fixed(1500),
    capital: fixed(60),
    hours: fixed(2),
    daysToCash: fixed(3),
    close,
    respond: fixed(1),
    directCost: fixed(10),
    volume: fixed(500),
    agreed: false,
    agreedValue: 0,
    agreedDeals: 0,
    fulfilledBy: null,
    competitiveAward: false,
  };
}

/** The CONVERSION link exactly as the plan reads it when buyers would be offered (deals > 0). */
const conversionCheck = (one: ModelledOpportunity): LinkCheck => ({ link: 'CONVERSION', ok: conversionState(one).state !== 'NONE', basis: one.close.note });
const target = { capitalBeforeProofCents: 37_500, currency: 'USD' } as unknown as Parameters<typeof validationStage>[2];
const stage = (one: ModelledOpportunity) => validationStage(one, [conversionCheck(one)], target, false);

describe('the inbound answer: money-committed inbound counts are buyer validation, interest signals are not', () => {
  it('paid pre-orders (or pledges) counted against unique landing-page visitors reach D_BUYER_VALIDATED through the existing path', () => {
    // 6 paid deposits from 240 unique visitors — above the ~200-visitor directional floor.
    const close = measuredRateInput({ trials: 240, low: 6, high: 6 });
    expect(inputEvidence(close, 'close')).toMatchObject({ tier: 'HISTORICAL', establishes: true });
    const one = opening(close);
    expect(conversionState(one).state).toBe('HISTORICAL');
    expect(conversionCheck(one).ok).toBe(true);
    expect(stage(one)).toBe('D_BUYER_VALIDATED');
  });

  const interest: Array<[string, ModelInput]> = [
    ['a signup-to-purchase rate somebody assumed', { value: null, low: 0.02, high: 0.1, provenance: 'ASSUMPTION', source: null, note: 'waitlist signups, purchase rate assumed' }],
    ['a fake-door click rate stated with no sample', fixed(0.05)],
  ];
  for (const [label, close] of interest) {
    it(`reproduces the failure class — ${label}: conversion is not established and the opening stays below D`, () => {
      expect(inputEvidence(close, 'close').establishes).toBe(false);
      const one = opening(close);
      expect(conversionState(one).state).toBe('NONE');
      expect(conversionCheck(one).ok).toBe(false);
      expect(stage(one)).not.toBe('D_BUYER_VALIDATED');
    });
  }

  it('a measured zero is a measurement, not a favourable assumption: 0 paid of 240 is a low measured rate', () => {
    const close = measuredRateInput({ trials: 240, low: 0, high: 0 });
    expect(close.provenance).toBe('HISTORICAL');
    expect(close.high!).toBeLessThan(0.03);
    expect(close.high!).toBeLessThan(measuredRateInput({ trials: 240, low: 6, high: 6 }).high!);
  });
});

describe('the failure class OPERATOR:MISSING_CAPABILITY:aed45eeb30f0ec42 does not loop back to the Factory', () => {
  beforeEach(async () => {
    await freshProject();
    await createUser({ email: `own-${uid()}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' });
  });

  const finding = (id: string, over: Record<string, unknown> = {}) =>
    upsertInventory(
      {
        id,
        capability: 'inbound buyer validation',
        symptom: 'No inbound mechanism yields a buyer-validated opening for the $10K plan without outreach or paid spend',
        evidence: 'Operator run opr_99026b0ef4c04df9b03d asked; Brain held no answer.',
        severity: 'BLOCKING',
        ...over,
      },
      ctx,
    );
  const offeredRefs = async () => (await inventoryDeficiencies(1000)).map((one) => one.source?.ref);
  const repairRow = async () =>
    (await upsertCandidate({
      weaknessKey: `OPERATOR:MISSING_CAPABILITY:${uid()}`, kind: 'OPERATOR:MISSING_CAPABILITY', title: 'inbound validation', problem: 'p', metric: 'RESEARCH_JOB_SUCCESS_RATE', downstreamMetric: null,
      ownerComponent: `operator:MISSING_CAPABILITY:${uid()}`, frequency: 1, denominator: 1, scope: 'GENERAL', severity: 'MEDIUM', evidence: {},
    })).candidate;

  it('is offered by its id as a goal-blocking MISSING_CAPABILITY, held while its repair is in flight and after a rejected repair, re-offered with a confirmed cause', async () => {
    const id = `INBOUND-10K-${uid()}`;
    expect((await finding(id)).ok).toBe(true);
    expect((await getInventoryItem(id))!.status).toBe('DISCOVERED');

    const offered = (await inventoryDeficiencies()).find((one) => one.source?.ref === id);
    expect(offered).toBeDefined();
    expect(readingId(offered!)).toBe(`dfx_inv_${id}`);
    expect(offered!.diagnosis.deficiency).toBe('MISSING_CAPABILITY');
    expect(offered!.diagnosis.blocksGoal).toBe(true);
    expect(offered!.diagnosis.cause).toBeNull();

    const repair = await repairRow();
    expect((await finding(id, { linkedCandidateId: repair.id })).ok).toBe(true);
    expect(await offeredRefs()).not.toContain(id);

    const control = `INBOUND-10K-${uid()}`;
    expect((await finding(control)).ok).toBe(true);
    expect(await decideCandidate(repair.id, 'REJECTED', 'no accepted claim')).toBe(true);
    const after = await offeredRefs();
    expect(after).toContain(control);
    expect(after).not.toContain(id);

    const cause = 'Answered: count paid pre-orders/pledges against unique visitors via measuredRateInput; signups and clicks never certify conversion.';
    expect((await finding(id, { rootCause: cause, status: 'ROOT_CAUSE_CONFIRMED' })).ok).toBe(true);
    expect((await inventoryDeficiencies()).find((one) => one.source?.ref === id)?.diagnosis.cause).toBe(cause);
  });
});

describe('a question the operator asked is answered by research and never sent to Factory as engineering', () => {
  const QUESTION =
    'Design an inbound validation mechanism for $10K PA Farm Vitality/home improvement plans that generates buyer-validated openings without direct outreach, paid spend, automated research, or Factory engineering.';
  const settled = (acceptedClaims: number): Pick<Linked, 'research' | 'archive'> => ({
    research: { settled: true, acceptedClaims, status: 'COMPLETE', claims: [] },
    archive: [],
  });

  beforeEach(async () => {
    await freshProject();
    const brain = (await getProjectBySlug('brain-architecture'))?.id ?? (await createProject({ name: 'Brain Architecture', slug: 'brain-architecture' })).id;
    await createLayer({ projectId: brain, name: 'Methods', orderIndex: 0 });
    const admin = `admin-${uid()}@example.com`;
    await createUser({ email: admin, displayName: 'Admin', password: 'correct horse battery staple 1', isBrainAdmin: true });
    // No Factory submission and no research goal from this test: only the register row is read.
    await setImprovementSwitch(false, admin, 'test: no Factory submission from this test');
  });

  it('reproduces the failure class: the commissioned question is marked a question, and once its research settles it closes instead of becoming a Factory objective', async () => {
    const out = await commissionResearch({ goalId: null, question: QUESTION, evidence: null, runId: 'opr_99026b0ef4c04df9b03d' });
    expect(out.ok).toBe(true);
    expect(out.intervention).toBe('EVIDENCE');
    const row = (await getCandidate(out.candidateId!))!;
    expect((row.evidence['directive'] as { question?: boolean }).question).toBe(true);
    expect(isResearchQuestion(row)).toBe(true);

    // Research not opened or not settled yet: the loop keeps researching, nothing closes.
    expect(questionClosure({ ...row, researchGoalId: null }, settled(3))).toBeNull();
    expect(questionClosure({ ...row, researchGoalId: 'rgl_q' }, { research: { settled: false, acceptedClaims: 0, status: 'RUNNING', claims: [] }, archive: [] })).toBeNull();

    // Settled with accepted claims: answered — the research is the answer, nothing to engineer.
    const answered = questionClosure({ ...row, researchGoalId: 'rgl_q' }, settled(8));
    expect(answered).toContain('Answered by method research rgl_q');
    expect(answered).toContain('nothing to engineer');
    // Settled with none: still closed, never handed to Factory, and said honestly.
    expect(questionClosure({ ...row, researchGoalId: 'rgl_q' }, settled(0))).toContain('no accepted claim');
  });

  it('recognises a question already in the register from before the flag (the row this job came from)', () => {
    const older = {
      title: `Research: ${QUESTION}`,
      researchGoalId: 'rgl_old',
      evidence: { directive: { origin: 'OPERATOR', intervention: 'EVIDENCE', deficiency: 'MISSING_CAPABILITY' }, ownerPaths: [] },
    };
    expect(isResearchQuestion(older)).toBe(true);
    expect(questionClosure(older, settled(8))).not.toBeNull();
  });

  it('does not touch a defect to repair: an engineering directive, owner paths or a known cause keep the Factory path', async () => {
    const base = { title: `Research: ${QUESTION}`, researchGoalId: 'rgl_x' };
    const engineering = { ...base, evidence: { directive: { origin: 'OPERATOR', intervention: 'ENGINEERING', question: true }, ownerPaths: [] } };
    const owned = { ...base, evidence: { directive: { origin: 'OPERATOR', intervention: 'EVIDENCE' }, ownerPaths: ['server/services/x.ts'] } };
    const caused = { ...base, evidence: { directive: { origin: 'OPERATOR', intervention: 'EVIDENCE' }, ownerPaths: [], knownCause: 'the rows say why' } };
    const detector = { ...base, evidence: {} };
    for (const one of [engineering, owned, caused, detector]) {
      expect(isResearchQuestion(one)).toBe(false);
      expect(questionClosure(one, settled(8))).toBeNull();
    }

    // A causeless defect diagnosis (not a question) is not marked a question either.
    const defect = await commission({
      goalId: null,
      deficiency: 'MISSING_CAPABILITY',
      title: 'Inbound replies are not recorded as measured close rates',
      observed: 'Replies to inbound pages arrive but no measured close rate is recorded, so conversion stays NONE on every opening.',
      evidence: 'Operator run opr_99026b0ef4c04df9b03d; rows cop_inbound',
      cause: null,
      ownerPaths: ['server/services/goals/portfolio.ts'],
      recurrence: 1,
      expectedBenefit: 'Measured conversion reaches the plan.',
      acceptance: 'A test shows a recorded inbound count becomes a measured rate.',
      metric: null,
      blocksGoal: false,
      share: null,
      proposed: 'EVIDENCE',
      runId: 'opr_99026b0ef4c04df9b03d',
    });
    expect(defect.ok).toBe(true);
    const row = (await getCandidate(defect.candidateId!))!;
    expect((row.evidence['directive'] as { question?: boolean }).question).toBeUndefined();
    expect(isResearchQuestion(row)).toBe(false);
  });
});

describe('the loop itself closes a settled research question instead of engineering it (the production change, end to end)', () => {
  const QUESTION =
    'Design an inbound validation mechanism for $10K PA Farm Vitality/home improvement plans that generates buyer-validated openings without direct outreach, paid spend, automated research, or Factory engineering.';
  let admin = '';
  let adminId = '';
  let brainId = '';
  let layerId = '';

  beforeEach(async () => {
    await freshProject();
    brainId = (await getProjectBySlug('brain-architecture'))?.id ?? (await createProject({ name: 'Brain Architecture', slug: 'brain-architecture' })).id;
    layerId = (await createLayer({ projectId: brainId, name: 'Methods', orderIndex: 0 })).id;
    admin = `admin-${uid()}@example.com`;
    adminId = (await createUser({ email: admin, displayName: 'Admin', password: 'correct horse battery staple 1', isBrainAdmin: true })).id;
  });

  it('advanceNow closes the commissioned question once its method research has settled, and opens no Factory objective', async () => {
    // Commission with the order off, so the question is registered without research or Factory side effects.
    await setImprovementSwitch(false, admin, 'test: register the question only');
    const out = await commissionResearch({ goalId: null, question: QUESTION, evidence: null, runId: 'opr_99026b0ef4c04df9b03d' });
    expect(out.ok).toBe(true);
    const id = out.candidateId!;
    // Its method research ran and ended: a goal that no longer exists, with no packet still running, reads settled with no accepted claim.
    expect(await patchCandidate(id, { researchGoalId: `rgl_settled_${uid()}` })).toBe(true);
    const before = (await getCandidate(id))!;
    expect(before.decision).toBeNull();
    expect(before.changeRequestId).toBeNull();

    // The order on: this is the step that, before the change, carried the row on toward Factory.
    await setImprovementSwitch(true, admin, 'test: let the loop advance the question');
    const { did, report } = await advanceNow(id);
    expect(report.errors).toEqual([]);
    expect(did).toBe('closed: research found no answer');

    const after = (await getCandidate(id))!;
    expect(after.decision).toBe('REJECTED');
    expect(after.changeRequestId).toBeNull();
    const decided = await listImprovementEvents({ candidateId: id, kinds: ['DECIDED'] });
    expect(decided.map((one) => one.detail['question'])).toContain(true);

    // Closed means closed: a second advance does nothing, and still no Factory objective.
    expect((await advanceNow(id)).did).toBeNull();
    expect((await getCandidate(id))!.changeRequestId).toBeNull();
  });

  /** A finished method-research packet under a research goal, carrying `accepted` accepted, sourced claims. Returns the goal. */
  async function settledResearch(accepted: number): Promise<string> {
    const goalId = (
      await createGoal({
        projectId: brainId, ownerUserId: adminId, createdByUserId: adminId, name: `method research ${uid()}`,
        allowedWork: ['RESEARCH'], maxMissions: 1, maxFragments: 4, maxConcurrent: 1, maxProbes: 0,
      })
    ).id;
    const run = await createRun({ projectId: brainId, layerId, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'q' });
    const packet = await createOrchestration({ projectId: brainId, layerId, runId: run.id, title: 'q', assignment: 'q', provider: 'WORKER', autoApprove: false });
    await createFragments([
      {
        orchestrationId: packet.id, projectId: brainId, layerId, geography: 'any market',
        requiredEvidence: [{ id: 'method', description: 'a documented validation method', necessity: 'CONDITIONAL' }],
        acceptableSourceTypes: ['a peer-reviewed paper'], excludedSourceTypes: ['a forecast'], completionCriteria: ['one source'],
        minIndependentSources: 1, maxRepairs: 2, fragmentIndex: 0, fragmentKey: 'method', question: 'q', dependsOn: [], attempt: 1,
      },
    ] as unknown as Parameters<typeof createFragments>[0]);
    const [fragment] = await currentFragments(packet.id);
    await updateFragment(fragment!.id, { status: 'ACCEPTED', completedAt: new Date().toISOString(), blockedReason: null });
    for (let i = 0; i < accepted; i += 1) {
      const text = `Reward crowdfunding pledges separate offers that attract backers from those that do not (${i}).`;
      const [claim] = await insertClaims([{
        orchestrationId: packet.id, fragmentId: fragment!.id, passId: null, passKey: 'BROAD_SCAN' as const,
        claim: text, sourceUrl: `https://conference.iza.org/conference_files/EntreRes2015/xu_t22362.pdf#${i}`, sourceTitle: 'Xu 2015', sourcePublisher: 'IZA', sourceDate: '2015-09-01',
        evidenceExcerpt: 'x', evidenceLocator: 'p. 1', evidenceLane: 'method', opportunitySignal: null, closesOn: null,
        retrievedAt: '2026-11-15', confidence: 0.8, validationState: 'SOURCED' as const, validationDetail: null, sourced: true,
        claimType: 'SOURCED_FACT' as const, contentHash: `${goalId}|${i}`,
      }] as unknown as Parameters<typeof insertClaims>[0]);
      await decideClaim(claim!.id, { accepted: true });
    }
    await getDb().run('UPDATE research_orchestrations SET goal_id = ?, status = ? WHERE id = ?', [goalId, 'COMPLETE', packet.id]);
    return goalId;
  }

  it('reproduces the failure class end to end: research that answered the question is not carried on to Factory as engineering', async () => {
    await setImprovementSwitch(false, admin, 'test: register the question only');
    const out = await commissionResearch({ goalId: null, question: QUESTION, evidence: null, runId: 'opr_99026b0ef4c04df9b03d' });
    expect(out.ok).toBe(true);
    const id = out.candidateId!;
    const goalId = await settledResearch(3);
    expect(await patchCandidate(id, { researchGoalId: goalId })).toBe(true);

    // Before the change, accepted claims moved the row to ENGINEER and on toward a Factory objective.
    await setImprovementSwitch(true, admin, 'test: let the loop advance the question');
    const { did, report } = await advanceNow(id);
    expect(report.errors).toEqual([]);
    expect(did).toBe('answered: research question closed');
    const after = (await getCandidate(id))!;
    expect(after.decision).toBe('REJECTED');
    expect(after.decisionReason ?? '').toContain('nothing to engineer');
    expect(after.changeRequestId).toBeNull();
    const decided = await listImprovementEvents({ candidateId: id, kinds: ['DECIDED'] });
    const closed = decided.find((one) => one.detail['question'] === true)!;
    expect(closed.detail['acceptedClaims']).toBe(3);

    // The answer is a record the asker can read and cite, not a comment: every accepted claim with its source,
    // the research goal it came from and the operator run that asked.
    const answer = closed.detail['answer'] as { claim: string; source: string | null }[];
    expect(answer).toHaveLength(3);
    for (const one of answer) {
      expect(one.claim).toContain('Reward crowdfunding pledges');
      expect(one.source).toMatch(/^https:\/\/conference\.iza\.org\//);
    }
    expect(closed.detail['researchGoalId']).toBe(goalId);
    expect(closed.detail['askedIn']).toBe('opr_99026b0ef4c04df9b03d');
    expect(String(closed.detail['questionText'])).toContain('inbound validation mechanism');
    expect(after.decisionReason ?? '').toContain('Answer: (1) Reward crowdfunding pledges');
    expect(after.decisionReason ?? '').toContain('[https://conference.iza.org/conference_files/EntreRes2015/xu_t22362.pdf#0]');
  });

  it('a question that closes with no supported answer records none, and invents nothing', () => {
    const empty = { research: { settled: true, acceptedClaims: 0, status: 'COMPLETE', claims: [] }, archive: [] };
    expect(questionAnswer(empty)).toEqual([]);
    expect(questionDecisionReason('closed.', [])).toBe('closed.');
    // Duplicates across research and archive are recorded once; an unsourced archive claim says so rather than borrowing a source.
    const answer = questionAnswer({
      research: { settled: true, acceptedClaims: 1, status: 'COMPLETE', claims: [{ claim: 'a', source: 'https://x.test/a' }] },
      archive: [{ claim: 'a', source: 'https://x.test/a', topic: null }, { claim: 'b', source: null, topic: null }],
    });
    expect(answer).toEqual([{ claim: 'a', source: 'https://x.test/a' }, { claim: 'b', source: null }]);
    expect(questionDecisionReason('closed.', answer)).toBe('closed. Answer: (1) a [https://x.test/a] (2) b [no source]');
  });

  it('advanceNow leaves a defect to repair on the Factory path: the same settled research does not close it', async () => {
    await setImprovementSwitch(false, admin, 'test: register the defect only');
    const defect = await commission({
      goalId: null,
      deficiency: 'MISSING_CAPABILITY',
      title: 'Inbound replies are not recorded as measured close rates',
      observed: 'Replies to inbound pages arrive but no measured close rate is recorded, so conversion stays NONE on every opening.',
      evidence: 'Operator run opr_99026b0ef4c04df9b03d; rows cop_inbound',
      cause: null,
      ownerPaths: ['server/services/goals/portfolio.ts'],
      recurrence: 1,
      expectedBenefit: 'Measured conversion reaches the plan.',
      acceptance: 'A test shows a recorded inbound count becomes a measured rate.',
      metric: null,
      blocksGoal: false,
      share: null,
      proposed: 'EVIDENCE',
      runId: 'opr_99026b0ef4c04df9b03d',
    });
    expect(defect.ok).toBe(true);
    const id = defect.candidateId!;
    expect(await patchCandidate(id, { researchGoalId: `rgl_settled_${uid()}` })).toBe(true);
    await setImprovementSwitch(true, admin, 'test: let the loop advance the defect');
    const { did } = await advanceNow(id);
    expect(did ?? '').not.toMatch(/research question closed|research found no answer/);
    const decided = await listImprovementEvents({ candidateId: id, kinds: ['DECIDED'] });
    expect(decided.some((one) => one.detail['question'] === true)).toBe(false);
  });
});

describe('OPERATOR:MISSING_CAPABILITY:aed45eeb30f0ec42 — the inbound count is read from the card, through modelOpportunity', () => {
  it('readInboundCommitments reads money-committed counts against unique visitors', () => {
    expect(readInboundCommitments('12 pre-orders from 240 unique visitors')).toEqual({ paid: 12, visitors: 240, unit: 'pre-orders' });
    expect(readInboundCommitments('9 paid deposits out of 1,310 visitors')).toEqual({ paid: 9, visitors: 1310, unit: 'deposits' });
    expect(readInboundCommitments('31 pledges of 500 unique visitors')).toEqual({ paid: 31, visitors: 500, unit: 'pledges' });
    expect(readInboundCommitments('4 paid orders among 90 visitors')).toEqual({ paid: 4, visitors: 90, unit: 'paid orders' });
  });

  it('refuses interest-only signals, a count with no visitors, and more paid than visitors', () => {
    for (const interest of ['40 email signups from 240 unique visitors', '25 waitlist joins of 200 visitors', '60 clicks on buy now from 300 visitors', '18 sign-ups out of 200 unique visitors']) {
      expect(readInboundCommitments(interest), interest).toBeNull();
    }
    expect(readInboundCommitments('12 pre-orders so far')).toBeNull();
    expect(readInboundCommitments('3% of buyers reply')).toBeNull();
    expect(readInboundCommitments('300 pre-orders from 240 unique visitors')).toBeNull();
    expect(readInboundCommitments('5 pre-orders from 0 visitors')).toBeNull();
  });

  async function inboundOpening(fact: { kind: 'PERSON' | 'RECOMMENDATION' | 'EVIDENCE'; value: string } | null) {
    const projectId = (await freshProject()).project.id;
    const userId = (await createUser({ email: `inbound-${uid()}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
    expect((await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Collect 10000 dollars of settled cash within 30 days.' })).ok).toBe(true);
    const mode = (await getCashMode(projectId))!;
    const opportunity = await createOpportunity({ projectId, cashModeId: mode.id, ownerUserId: userId, title: 'PA Farm Vitality home-improvement plan', mechanism: 'EXPLICIT_PAID_REQUEST', currency: mode.currency, requiredCapabilities: [] });
    if (fact) {
      await recordCardFact({ projectId, opportunityId: opportunity.id, field: 'conversionRates', kind: fact.kind, value: fact.value, claimId: fact.kind === 'EVIDENCE' ? `clm_inbound_${uid()}` : undefined, decidedBy: fact.kind === 'RECOMMENDATION' ? 'BRAIN' : userId });
    }
    const modelled = await modelOpportunity({ ...opportunity, priceCents: 1_000_000 }, 0, 'A', mode.currency, [], null, new Date('2026-11-16T00:00:00.000Z'));
    if ('reason' in modelled) throw new Error(modelled.reason);
    return modelled;
  }

  it('a paid pre-order count a person recorded on the card is the measured close, HISTORICAL, and reads as conversion', async () => {
    const modelled = await inboundOpening({ kind: 'PERSON', value: '12 pre-orders from 240 unique visitors' });
    expect(modelled.close.provenance).toBe('HISTORICAL');
    expect(modelled.close.note).toContain('12 money-committed pre-orders from 240 unique visitors');
    expect(modelled.respond.value).toBe(1);
    expect(conversionState(modelled).state).toBe('HISTORICAL');
  });

  it('a sourced claim on the card counts the same way', async () => {
    const modelled = await inboundOpening({ kind: 'EVIDENCE', value: '31 pledges of 500 unique visitors' });
    expect(modelled.close.provenance).toBe('HISTORICAL');
    expect(modelled.close.note).toContain('31 money-committed pledges from 500 unique visitors');
  });

  it("Brain's own proposal on the card is never read as a measured close", async () => {
    const modelled = await inboundOpening({ kind: 'RECOMMENDATION', value: '12 pre-orders from 240 unique visitors' });
    expect(modelled.close.provenance).not.toBe('HISTORICAL');
    expect(modelled.close.note).not.toContain('inbound page');
    expect(conversionState(modelled).state).not.toBe('HISTORICAL');
  });

  it('an interest-only count on the card is never fed in as a close rate', async () => {
    const modelled = await inboundOpening({ kind: 'PERSON', value: '40 email signups from 240 unique visitors' });
    expect(modelled.close.note).not.toContain('inbound page');
    expect(conversionState(modelled).state).not.toBe('HISTORICAL');
  });

  it('with no inbound count on the card the close stays unmeasured', async () => {
    const modelled = await inboundOpening(null);
    expect(modelled.close.provenance).not.toBe('HISTORICAL');
    expect(conversionState(modelled).state).toBe('NONE');
  });
});
