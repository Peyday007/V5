/**
 * The app-session goal-to-plan path, end to end on Brain's real services (sessionPlanning.ts):
 * a migrated database with a project in Cash Mode (the planning bench's own template), goals
 * created from the owner's words by `createGoal`, routes admitted through the route proposer's
 * parser and writer, Brain's real planner (`readGoalPlan`), the checks, reviews, publication and
 * a reload from the database file. The ten controls of the build brief (2026-11-26) are each a
 * case below; the reasoning a session supplies is the revision payload each case submits.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlanRevisionInput } from '../server/domain/sessionPlanning.ts';
import type { PlanExecutor } from '../server/domain/planReady.ts';

const AUTHOR: PlanExecutor = { kind: 'APP_SESSION', id: 'test-session-author', model: 'claude-opus-5-5' };
const REVIEWER: PlanExecutor = { kind: 'MODEL', id: 'test-independent-reviewer', model: 'claude-opus-5-5' };

let dir = '';
let dbFile = '';
let world: { projectId: string; userId: string };

async function openDb(file: string) {
  const { closeDatabase, initDatabase } = await import('../server/db/database.ts');
  await closeDatabase({ drainMs: 50 });
  await initDatabase({ dbPath: file });
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-planning-'));
  const { buildTemplate, proveDeliverables } = await import('../bench/planningReliability/world.ts');
  const t = await buildTemplate(dir);
  dbFile = path.join(dir, 'session.db');
  fs.copyFileSync(t.file, dbFile);
  await openDb(dbFile);
  await proveDeliverables();
  world = { projectId: t.projectId, userId: t.userId };
}, 180_000);

afterAll(async () => {
  const { closeDatabase } = await import('../server/db/database.ts');
  await closeDatabase({ drainMs: 50 });
  fs.rmSync(dir, { recursive: true, force: true });
});

async function goalFrom(objective: string): Promise<string> {
  const { createGoal } = await import('../server/services/goals/decide.ts');
  const r = await createGoal({ projectId: world.projectId, objective, actorRef: `person:${world.userId}`, userId: world.userId });
  if (!r.ok) throw new Error(`goal not created: ${r.reason}`);
  return r.goal.id;
}

const terms = (over: Record<string, unknown> = {}) => ({
  targetCents: 300_000, currency: 'USD', metric: 'COLLECTED_CASH', windowDays: 30,
  totalSpendCapCents: 50_000, preProofSpendCapCents: 20_000, exposureCapCents: 50_000,
  proofCondition: 'two paid orders from distinct buyers', ownerHoursPerWeek: null, ownerPhysicalWork: 'FORBIDDEN',
  exclusions: [], evidenceExclusions: [], ...over,
});

const route = (over: Record<string, unknown> = {}) => ({
  title: 'Bookkeeping clean-up for dental practices', buyerKind: 'B2B', mechanism: 'CAPABILITY_ARBITRAGE', industry: 'dental practices',
  payer: 'Independent dental practices', offer: 'A year-end bookkeeping clean-up', price: 750, channel: 'Email to practice managers',
  performer: 'SUBCONTRACTOR', fulfiller: 'A quoted bookkeeping contractor', directCost: 150, capital: 150, ownerHoursPerDeal: 0,
  acquisitionCostPerSale: null, daysToFirstCash: 10, buyerCount: null, volumeBasis: '', assumptions: 'test route', ownerFit: 'no owner work',
  searches: { price: [], demand: [], volume: [] }, ...over,
});

function revision(goalId: string, contractDigest: string, opp: string, over: Partial<PlanRevisionInput> = {}): PlanRevisionInput {
  return {
    goalId, contractDigest, parentRevisionId: null, stance: 'EXECUTABLE',
    strategy: { title: 'Bookkeeping clean-ups through practice managers', opportunityIds: [opp], why: 'test' },
    alternatives: [{ title: 'do nothing', why: 'collects nothing' }],
    steps: [
      { id: 'reach', kind: 'REACH', label: 'email practice managers', performer: 'BRAIN', costCents: 5_000, day: 1, dependsOn: null, evidence: ['q_conv'] },
      { id: 'deliver', kind: 'DELIVER', label: 'contractor delivers the clean-up, paid per job on delivery', performer: 'A quoted bookkeeping contractor', costCents: 40_000, day: 8, dependsOn: 'collect', evidence: ['q_cost'] },
      { id: 'collect', kind: 'COLLECT', label: 'collect prepayment', performer: 'BRAIN', costCents: 0, day: 5, dependsOn: 'reach', evidence: ['q_price'] },
    ],
    cash: [
      { day: 1, kind: 'SPEND', amountCents: 5_000, label: 'list', stepId: 'reach' },
      { day: 5, kind: 'RECEIPT', amountCents: 300_000, label: 'four prepaid jobs', settlesDay: 7 },
      { day: 8, kind: 'SPEND', amountCents: 40_000, label: 'contractor x4', stepId: 'deliver' },
    ],
    proofDay: 7,
    quantities: [
      { name: 'price per job', status: 'EVIDENCED', value: 750, unit: 'USD', sources: ['s1'], needs: null },
      { name: 'contractor cost per job', status: 'EVIDENCED', value: 100, unit: 'USD', sources: ['s2'], needs: null },
      { name: 'buyer conversion per 100 emails', status: 'EVIDENCED', value: 2, unit: 'orders', sources: ['s3'], needs: null },
    ],
    sources: [
      { id: 's1', url: 'https://example.test/price', dated: '2026-10-01', claim: 'practices pay $750', population: 'independent dental practices', matchesBuyer: true },
      { id: 's2', url: 'https://example.test/quote', dated: '2026-11-20', claim: 'contractor quote $100', population: 'supplier', matchesBuyer: true },
      { id: 's3', url: 'https://example.test/pilot', dated: '2026-11-15', claim: '4 paid from 200 emails', population: 'independent dental practices', matchesBuyer: true },
    ],
    validation: { proof: 'two paid orders', stop: ['no paid order by day 7'], continue: ['two paid orders'] },
    noPlan: null, reach: null, answers: [], ...over,
  };
}

describe('the app-session goal-to-plan path on real Brain services', () => {
  let goalId = '';
  let digest = '';
  let opp = '';

  it('creates the goal from the raw objective, establishes the contract and refuses an unexplained mismatch', async () => {
    goalId = await goalFrom('Collect $3,000 in customer payments within 30 days. Maximum total spending: $500. Maximum cumulative spending before proof of demand: $200.');
    const svc = await import('../server/services/planning/sessionPlanning.ts');
    const stored = await svc.storedTerms(goalId);
    expect(stored).toMatchObject({ targetCents: 300_000, capitalCeilingCents: 50_000, capitalBeforeProofCents: 20_000 });
    await expect(svc.establishContract({ goalId, words: 'x', source: { kind: 'OWNER_MESSAGE', ref: 't', at: '2026-11-26' }, terms: terms({ targetCents: 400_000 }) as never, actor: AUTHOR })).rejects.toThrow(/target/);
    const c = await svc.establishContract({ goalId, words: 'Collect $3,000…', source: { kind: 'OWNER_MESSAGE', ref: 't', at: '2026-11-26' }, terms: terms() as never, actor: AUTHOR });
    expect(c.contract.version).toBe(1);
    digest = c.contract.digest;
  }, 60_000);

  it('admits the session route through the route proposer’s parser and writer as a hypothesis', async () => {
    const svc = await import('../server/services/planning/sessionPlanning.ts');
    const a = await svc.admitRoutes({ goalId, routes: [route(), route({ title: 'Unknown-cost route', payer: 'Orthodontists', directCost: null })], actor: AUTHOR });
    expect(a.refused).toEqual([]);
    expect(a.filed.map((f) => f.directCostKnown)).toEqual([true, false]);
    opp = a.filed[0]!.id;
    // Idempotent on resume: the same route is never filed twice.
    const again = await svc.admitRoutes({ goalId, routes: [route()], actor: AUTHOR });
    expect(again.filed[0]).toMatchObject({ id: opp, existing: true });
    const { cardFactsFor } = await import('../server/repos/cashCardFacts.ts');
    const facts = await cardFactsFor(a.filed[1]!.id);
    expect(facts.find((f) => f.field === 'directCosts')).toBeUndefined();
    expect(facts.every((f) => f.kind !== 'EVIDENCE')).toBe(true);
  }, 60_000);

  it('raises the planner’s questions, and admits the session’s research only through Brain’s evidence gate: invalid stays unverified, valid becomes evidence and moves the plan', async () => {
    const svc = await import('../server/services/planning/sessionPlanning.ts');
    const run = await svc.runBrain({ goalId, actor: AUTHOR });
    expect(run.completed).toBe(true);
    expect(run.openings.map((o) => o.opportunityId)).toContain(opp);
    const questions = (await svc.openQuestions(goalId)).filter((one) => one.opportunityId === opp);
    expect(questions.length).toBeGreaterThan(0);
    // Brain started no research for them: parked, so the session is their executor.
    expect(questions.every((q) => q.parked)).toBe(true);
    const q = questions[0]!;
    const { cardFactsFor } = await import('../server/repos/cashCardFacts.ts');
    const factOf = async () => (await cardFactsFor(opp)).find((f) => f.field === q.field) ?? null;
    const before = await factOf();
    const statement = q.field === 'buyerVolume'
      ? 'The state dental board lists 2,140 independent dental practices, each closing its books every year.'
      : 'Independent dental practices pay $750 for a year-end bookkeeping clean-up.';
    const match = { geography: 'MATCH', timeframe: 'MATCH', population: 'MATCH', definitions: 'MATCH' };

    // Invalid evidence: a source that is not a URL. The gate refuses it whatever the verifier says, and the card is unchanged.
    const bad = await svc.answerResearch({ goalId, needId: q.needId, actor: AUTHOR, method: 'search', claims: [{ claim: statement, sourceUrl: 'a colleague told me', sourceTitle: null, sourcePublisher: null, sourceDate: null, evidenceExcerpt: statement, evidenceLocator: 'n/a', primarySource: false }] });
    expect(bad.claims[0]!.sourced).toBe(false);
    await expect(svc.verifyResearch({ goalId, needId: q.needId, verifier: AUTHOR, verdicts: [], sufficiency: 'SUFFICIENT' })).rejects.toThrow(/cannot verify its own/);
    const refused = await svc.verifyResearch({ goalId, needId: q.needId, verifier: REVIEWER, verdicts: [{ claimId: bad.claims[0]!.claimId, supportsClaim: true, scopeMatch: match, note: 'looks right' }], sufficiency: 'SUFFICIENT' });
    expect(refused.claims[0]!.accepted).toBe(false);
    expect(refused.claims[0]!.rejectionReason).toBeTruthy();
    expect(refused.answered).toBeNull();
    expect((await factOf())?.kind ?? null).toBe(before?.kind ?? null);
    expect((await factOf())?.kind).not.toBe('EVIDENCE');

    // A valid, sourced, dated answer the independent verifier confirms: the gate accepts it, the card holds it as EVIDENCE,
    // the question is settled and the planner reruns on it.
    const good = await svc.answerResearch({ goalId, needId: q.needId, actor: AUTHOR, method: 'state board directory read', claims: [{ claim: statement, sourceUrl: 'https://example.test/dental-board/directory', sourceTitle: 'Licensed practices', sourcePublisher: 'State Dental Board', sourceDate: '2026-10-01', evidenceExcerpt: statement, evidenceLocator: 'Directory summary, paragraph 1', primarySource: true }] });
    expect(good.claims[0]!.sourced).toBe(true);
    const accepted = await svc.verifyResearch({ goalId, needId: q.needId, verifier: REVIEWER, verdicts: [{ claimId: good.claims[0]!.claimId, supportsClaim: true, scopeMatch: match, scopeBasis: { geography: 'any market', population: 'Independent dental practices', timeframe: 'current', definitions: q.field }, note: 'the directory states it' }], sufficiency: 'SUFFICIENT' });
    expect(accepted.claims[0]!.accepted).toBe(true);
    expect(accepted.answered).not.toBeNull();
    expect(accepted.input.after?.kind).toBe('EVIDENCE');
    expect(accepted.input.after?.value).not.toBe(before?.value ?? null);
    expect(accepted.rerun.completed).toBe(true);
    expect((await svc.openQuestions(goalId)).some((one) => one.needId === q.needId)).toBe(false);
  }, 180_000);

  it('control 1: a feasible, fully evidenced objective returns a complete plan that is reviewed and published', async () => {
    const svc = await import('../server/services/planning/sessionPlanning.ts');
    const r = await svc.submitRevision({ revision: { ...revision(goalId, digest, opp), chain: [{ opportunityId: opp, missing: [] }], resolves: [] }, actor: AUTHOR, today: '2026-11-26' });
    expect(r.brain.completed).toBe(true);
    expect(r.problems).toEqual([]);
    // The structured judgement a grader reads survives the transport.
    expect(r.revision.chain).toEqual([{ opportunityId: opp, missing: [] }]);
    await svc.recordReview({ goalId, revisionId: r.revision.revisionId, reviewer: REVIEWER, verdict: 'PASS', reasons: 'recomputed and consistent', findings: [] });
    const f = await svc.finalizePlan({ goalId, revisionId: r.revision.revisionId, actor: AUTHOR });
    expect(f.published).toBe(true);
  }, 240_000);

  it('control 2: missing supplier or demand evidence stays unknown and caps the stance at CONDITIONAL', async () => {
    const svc = await import('../server/services/planning/sessionPlanning.ts');
    const unknown = { name: 'buyer conversion per 100 emails', status: 'UNKNOWN' as const, value: null, unit: 'orders', sources: [], needs: 'a 200-email live test' };
    const base = revision(goalId, digest, opp);
    const exec = await svc.submitRevision({ revision: { ...base, quantities: [base.quantities[0]!, base.quantities[1]!, unknown] }, actor: AUTHOR, today: '2026-11-26' });
    expect(exec.problems.map((p) => p.code)).toContain('UNKNOWN_IN_EXECUTABLE');
    const filled = await svc.submitRevision({ revision: { ...base, stance: 'CONDITIONAL', quantities: [{ ...unknown, value: 0.02 }] }, actor: AUTHOR, today: '2026-11-26' });
    expect(filled.problems.map((p) => p.code)).toContain('UNKNOWN_FILLED');
    const cond = await svc.submitRevision({ revision: { ...base, stance: 'CONDITIONAL', quantities: [base.quantities[0]!, base.quantities[1]!, unknown] }, actor: AUTHOR, today: '2026-11-26' });
    expect(cond.problems).toEqual([]);
  }, 120_000);

  it('control 3: evidence about another buyer population is refused for this buyer’s demand', async () => {
    const svc = await import('../server/services/planning/sessionPlanning.ts');
    const base = revision(goalId, digest, opp);
    const r = await svc.submitRevision({ revision: { ...base, sources: base.sources.map((s) => (s.id === 's3' ? { ...s, population: 'veterinary clinics', matchesBuyer: false } : s)) }, actor: AUTHOR, today: '2026-11-26' });
    expect(r.problems.map((p) => p.code)).toContain('EVIDENCE_TRANSFER');
  }, 60_000);

  it('control 4: a correct final profit with an interim cash shortfall is caught', async () => {
    const svc = await import('../server/services/planning/sessionPlanning.ts');
    const base = revision(goalId, digest, opp);
    const r = await svc.submitRevision({
      revision: { ...base, cash: [{ day: 1, kind: 'SPEND', amountCents: 45_000, label: 'contractor deposit' }, { day: 2, kind: 'SPEND', amountCents: 4_000, label: 'list' }, { day: 3, kind: 'RECEIPT', amountCents: 300_000, label: 'jobs', settlesDay: 20 }, { day: 4, kind: 'REFUND', amountCents: 2_000, label: 'one refund' }] },
      actor: AUTHOR, today: '2026-11-26',
    });
    expect(r.trace.netCents).toBeGreaterThan(0);
    expect(r.problems.map((p) => p.code)).toEqual(expect.arrayContaining(['CASH_SHORTFALL', 'PRE_PROOF_SPEND_OVER']));
  }, 60_000);

  it('control 5: the $ total and pre-proof caps hold even when receipts replenish cash', async () => {
    const svc = await import('../server/services/planning/sessionPlanning.ts');
    const base = revision(goalId, digest, opp);
    const r = await svc.submitRevision({
      revision: { ...base, cash: [{ day: 1, kind: 'SPEND', amountCents: 25_000, label: 'pre-proof spend' }, { day: 3, kind: 'RECEIPT', amountCents: 300_000, label: 'jobs', settlesDay: 4 }, { day: 10, kind: 'SPEND', amountCents: 20_000, label: 'more' }, { day: 11, kind: 'COMMIT', amountCents: 10_000, label: 'revision allowance' }] },
      actor: AUTHOR, today: '2026-11-26',
    });
    const codes = r.problems.map((p) => p.code);
    expect(codes).toContain('PRE_PROOF_SPEND_OVER');
    expect(codes).toContain('TOTAL_SPEND_OVER');
  }, 60_000);

  it('control 10: a simulated reach without calibration is never presented as a known chance', async () => {
    const svc = await import('../server/services/planning/sessionPlanning.ts');
    const r = await svc.submitRevision({ revision: { ...revision(goalId, digest, opp), reach: { value: 0.9, calibrated: false, presentedAs: 'PROBABILITY' } }, actor: AUTHOR, today: '2026-11-26' });
    expect(r.problems.map((p) => p.code)).toContain('REACH_UNCALIBRATED');
  }, 60_000);

  it('control 8: truncated output, a failed planner call, an unavailable or self-reviewer never certify', async () => {
    const svc = await import('../server/services/planning/sessionPlanning.ts');
    const { steps: _s, ...partial } = revision(goalId, digest, opp);
    const t = await svc.submitRevision({ revision: partial as never, actor: AUTHOR, today: '2026-11-26' });
    expect(t.problems.map((p) => p.code)).toContain('INCOMPLETE_OUTPUT');
    const failed = await svc.runBrain({ goalId, actor: AUTHOR, timeoutMs: 1 });
    expect(failed.completed).toBe(false);
    const afterFail = await svc.submitRevision({ revision: revision(goalId, digest, opp), actor: AUTHOR, today: '2026-11-26' });
    expect(afterFail.problems.map((p) => p.code)).toContain('BRAIN_CHECK_FAILED');
    await svc.runBrain({ goalId, actor: AUTHOR });
    const ok = await svc.submitRevision({ revision: revision(goalId, digest, opp), actor: AUTHOR, today: '2026-11-26' });
    expect(ok.problems).toEqual([]);
    await svc.recordReview({ goalId, revisionId: ok.revision.revisionId, reviewer: REVIEWER, verdict: 'UNAVAILABLE', reasons: '', findings: [] });
    expect((await svc.finalizePlan({ goalId, revisionId: ok.revision.revisionId, actor: AUTHOR })).published).toBe(false);
    await svc.recordReview({ goalId, revisionId: ok.revision.revisionId, reviewer: AUTHOR, verdict: 'PASS', reasons: 'looks fine to me', findings: [] });
    const self = await svc.finalizePlan({ goalId, revisionId: ok.revision.revisionId, actor: AUTHOR });
    expect(self.published).toBe(false);
    expect((self.blockers ?? []).join(' ')).toMatch(/not independent/);
  }, 240_000);

  it('control 7: a changed supplier cost propagates into the economics and supersedes the published plan', async () => {
    const svc = await import('../server/services/planning/sessionPlanning.ts');
    const base = revision(goalId, digest, opp);
    const first = await svc.submitRevision({ revision: base, actor: AUTHOR, today: '2026-11-26' });
    await svc.recordReview({ goalId, revisionId: first.revision.revisionId, reviewer: REVIEWER, verdict: 'PASS', reasons: 'ok', findings: [] });
    expect((await svc.finalizePlan({ goalId, revisionId: first.revision.revisionId, actor: AUTHOR })).published).toBe(true);
    // The contractor's quote rises from $100 to $160 a job: the session revises the cost, the cash and the narrative.
    const dearer = await svc.submitRevision({
      revision: {
        ...base, parentRevisionId: first.revision.revisionId,
        quantities: base.quantities.map((q) => (q.name === 'contractor cost per job' ? { ...q, value: 160 } : q)),
        cash: base.cash.map((e) => (e.label === 'contractor x4' ? { ...e, amountCents: 64_000 } : e)),
        steps: base.steps.map((s) => (s.id === 'deliver' ? { ...s, costCents: 64_000 } : s)),
        strategy: { ...base.strategy, why: 'contractor now quotes $160 a job' },
      },
      actor: AUTHOR, today: '2026-11-26',
    });
    expect(dearer.trace.totalSpentCents).toBe(69_000);
    expect(dearer.problems.map((p) => p.code)).toContain('TOTAL_SPEND_OVER');
    const state = await svc.planningState(goalId);
    expect(state.final).toBeNull();
    expect(state.staleFinal?.revisionId).toBe(first.revision.revisionId);
  }, 120_000);

  it('control 6: a changed target invalidates the old plan and its revisions', async () => {
    const svc = await import('../server/services/planning/sessionPlanning.ts');
    const before = await svc.planningState(goalId);
    const { changeObjective } = await import('../server/services/goals/decide.ts');
    const changed = await changeObjective(goalId, { intent: 'Collect $2,000 in customer payments within 30 days. Maximum total spending: $500. Maximum cumulative spending before proof of demand: $200.' }, `person:${world.userId}`);
    expect(changed.ok).toBe(true);
    // The stored goal now says $2,000; the old contract no longer matches it and a new one is established.
    const c2 = await svc.establishContract({ goalId, words: 'Collect $2,000…', source: { kind: 'OWNER_MESSAGE', ref: 't2', at: '2026-11-27' }, terms: terms({ targetCents: 200_000 }) as never, actor: AUTHOR });
    expect(c2.changed).toBe(true);
    expect(c2.contract.version).toBe(2);
    expect(c2.invalidated.length).toBe(before.revisions.length);
    const stale = await svc.submitRevision({ revision: revision(goalId, digest, opp), actor: AUTHOR, today: '2026-11-27' });
    expect(stale.problems.map((p) => p.code)).toContain('STALE_CONTRACT');
    expect((await svc.finalizePlan({ goalId, revisionId: stale.revision.revisionId, actor: AUTHOR })).published).toBe(false);
    digest = c2.contract.digest;
    const fresh = await svc.submitRevision({ revision: revision(goalId, digest, opp, { cash: [{ day: 1, kind: 'SPEND', amountCents: 5_000, label: 'list', stepId: 'reach' }, { day: 5, kind: 'RECEIPT', amountCents: 200_000, label: 'jobs', settlesDay: 7 }, { day: 8, kind: 'SPEND', amountCents: 30_000, label: 'contractor x3', stepId: 'deliver' }], steps: revision(goalId, digest, opp).steps.map((s) => (s.id === 'deliver' ? { ...s, costCents: 30_000 } : s)) }), actor: AUTHOR, today: '2026-11-27' });
    expect(fresh.problems).toEqual([]);
  }, 240_000);

  it('control 9: interrupted work resumes from the database file with its constraints intact', async () => {
    const svc = await import('../server/services/planning/sessionPlanning.ts');
    const before = await svc.planningState(goalId);
    await openDb(dbFile);
    const after = await (await import('../server/services/planning/sessionPlanning.ts')).planningState(goalId);
    expect(after.current?.revisionId).toBe(before.current?.revisionId);
    expect(after.current?.digest).toBe(before.current?.digest);
    expect(after.contract?.terms).toEqual(before.contract?.terms);
    expect(after.contract?.terms.preProofSpendCapCents).toBe(20_000);
  }, 60_000);
});

describe('the decision contract keeps unknowns unknown', () => {
  it('ranks no option on an unknown cost, keeps an explicit zero, refuses a non-finite figure and accepts an unknown probability', async () => {
    const { reviewDecision } = await import('../server/domain/decision.ts');
    const base = { kind: 'RESEARCH' as const, goalId: null, question: 'which?', chosen: 1, assumptions: ['a'], whyNotHighestEv: null, prediction: { outcome: 'x', probability: null, horizonDays: 10 }, irreversible: false };
    const r = reviewDecision({ ...base, options: [{ action: 'unknown cost', probability: 0.9, valueUsd: 1000, costUsd: null, evidence: [] }, { action: 'known cost', probability: 0.9, valueUsd: 1000, costUsd: 100, evidence: [] }] });
    expect(r.options.map((o) => o.expectedValueUsd)).toEqual([null, 800]);
    expect(r.bestByEv).toBe(1);
    expect(r.ok).toBe(true);
    const zero = reviewDecision({ ...base, chosen: 0, options: [{ action: 'free', probability: 0.9, valueUsd: 1000, costUsd: 0, evidence: [] }, { action: 'paid', probability: 0.9, valueUsd: 1000, costUsd: 100, evidence: [] }] });
    expect(zero.options[0]!.expectedValueUsd).toBe(900);
    const bad = reviewDecision({ ...base, options: [{ action: 'a', probability: 0.5, valueUsd: 1, costUsd: Number.NaN, evidence: [] }, { action: 'b', probability: null, valueUsd: 1, costUsd: 0, evidence: [] }] });
    expect(bad.ok).toBe(false);
    expect(bad.problems.join(' ')).toMatch(/costUsd/);
    expect(bad.options[1]!.expectedValueUsd).toBeNull();
  });

  it('reads the owner’s labelled spending limits and collected-payments metric from the raw words', async () => {
    const { readObjective } = await import('../server/services/industry/construction/intent.ts');
    const r = readObjective('Produce the strongest executable plan you can for collecting $10,000 in customer revenue within 30 days, subject to: Maximum total spending: $2,000. Maximum cumulative spending before proof of demand: $300 across all experiments and routes combined.', new Date('2026-11-26T00:00:00Z'));
    expect(r).toMatchObject({ amount: 10000, capitalCeiling: 2000, beforeProof: 300, metric: 'COLLECTED_CASH', unread: [] });
  });
});
