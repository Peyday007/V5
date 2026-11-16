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
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { decideCandidate, getCandidate, upsertCandidate } from '../server/repos/improvement.ts';
import { createProject, getProjectBySlug } from '../server/repos/projects.ts';
import { createLayer } from '../server/repos/layers.ts';
import { setImprovementSwitch } from '../server/services/improvement/authority.ts';
import { isResearchQuestion, questionClosure } from '../server/services/improvement/loop.ts';
import type { Linked } from '../server/services/improvement/loop.ts';
import { getInventoryItem, upsertInventory } from '../server/services/operator/inventory.ts';
import { commission, commissionResearch, inventoryDeficiencies, readingId } from '../server/services/operator/director.ts';
import { inputEvidence, measuredRateInput } from '../server/services/goals/portfolio.ts';
import { conversionState, validationStage } from '../server/services/goals/plan.ts';
import type { LinkCheck } from '../server/services/goals/plan.ts';
import type { ModelInput, ModelledOpportunity } from '../server/services/cash/goalScenario.ts';

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
