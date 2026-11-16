/**
 * §111 on real rows: Hermes commissions engineering with two materially different
 * approaches; Brain opens one experiment (the deficiency's one register row as parent, each
 * approach its own row and Factory objective, no release grant); the evaluator reads what is
 * pending, records scores, and the decision grants the existing release to the winner only,
 * rejects the loser with its score, closes the parent into the winner and learns which
 * approach types work. Restart-safe and decided once.
 *
 * Factory's submit, start and grant are replaced at their module boundary (they reach
 * GitHub), and so are the campaign reads, which a test sets to what Factory would report.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const factory = vi.hoisted(() => ({
  submitted: [] as Array<Record<string, unknown>>,
  granted: [] as string[],
  campaigns: new Map<string, Record<string, unknown>>(),
}));

vi.mock('../server/services/factory/contract.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/services/factory/contract.ts')>();
  return {
    ...actual,
    submitObjective: vi.fn(async (input: Record<string, unknown>) => {
      factory.submitted.push(input);
      return { changeRequest: { id: `fcr_test${factory.submitted.length}` }, created: true };
    }),
  };
});
vi.mock('../server/services/factory/start.ts', () => ({
  approveAndStartCampaign: vi.fn(async (input: { changeRequestId: string }) => {
    const id = `fcp_for_${input.changeRequestId}`;
    factory.campaigns.set(id, { id, changeRequestId: input.changeRequestId, state: 'EXECUTING', prUrl: null, integrationSha: null, integrationBranch: `factory/${id}` });
    return { ok: true, changeRequest: { id: input.changeRequestId, riskClass: 'LOW' }, campaign: { id }, campaignCreated: true, execution: { mode: 'REMOTE', note: 'test' } };
  }),
}));
vi.mock('../server/services/factory/release/grant.ts', () => ({
  authorizeAutomaticRelease: vi.fn(async (input: { changeRequestId: string }) => {
    factory.granted.push(input.changeRequestId);
    return { grant: { id: 'grant' }, created: true };
  }),
}));
vi.mock('../server/repos/factory.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/repos/factory.ts')>();
  return {
    ...actual,
    getCampaign: vi.fn(async (id: string) => factory.campaigns.get(id) ?? null),
    getChangeRequest: vi.fn(async (id: string) => ({ id, riskClass: 'LOW', state: 'APPROVED' })),
  };
});

import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createProject, getProjectBySlug } from '../server/repos/projects.ts';
import { createLayer } from '../server/repos/layers.ts';
import { createUser } from '../server/repos/identity.ts';
import { setProjectRepository } from '../server/repos/factory.ts';
import { getCandidate, listCandidates } from '../server/repos/improvement.ts';
import { listApproachStats, listVariants, getExperiment } from '../server/repos/evolution.ts';
import { setImprovementSwitch } from '../server/services/improvement/authority.ts';
import { findTool } from '../server/mcp/tools.ts';
import { OPERATOR_TOOL_NAMES, operatorBrief } from '../server/domain/operator.ts';

const request = (over: Record<string, unknown> = {}) => ({
  goalId: null,
  deficiency: 'CAPABILITY_BELOW_TARGET',
  title: 'Plans treat unfunded deals as available capital',
  observed: 'The feasibility benchmark reads accuracy 0.80 against a target of 0.95: plans count hypothetical answers to constraints as settled.',
  evidence: 'evr_1: accuracy 0.80 on 40 cases; evr_2: accuracy 0.79',
  cause: 'the pathway builder reads an open question about funding as a satisfied constraint when the deal row exists',
  ownerPaths: ['server/services/goals/plan.ts'],
  recurrence: 3,
  expectedBenefit: 'Plans only count capital that exists, so the goal pursues reachable pathways.',
  acceptance: 'A test shows a pathway whose funding is an open question is not ranked as feasible.',
  metric: null,
  blocksGoal: false,
  share: 0.1,
  proposed: null,
  runId: 'opr_evo',
  suite: 'feasibility',
  approaches: [
    { label: 'gate', approachType: 'EVALUATION_MACHINERY', approach: 'Add a feasibility gate that refuses any pathway whose funding constraint is answered only by an open question row.', ownerPaths: ['server/services/goals/plan.ts'] },
    { label: 'retrieve', approachType: 'RETRIEVAL', approach: 'Read the ledger for evidence of committed capital before construction, and attach an explicit unknown when none is recorded.', ownerPaths: ['server/services/goals/constraints.ts'] },
  ],
  ...over,
});

function finishBuilding(campaignId: string, n: number): void {
  const c = factory.campaigns.get(campaignId)!;
  factory.campaigns.set(campaignId, { ...c, state: 'COMPLETE', prUrl: `https://github.com/peyday007/v5/pull/${n}`, integrationSha: `head${n}` });
}

const result = (metrics: Record<string, number>, over: Record<string, unknown> = {}) => ({
  suite: 'feasibility',
  sha: 'sha',
  ref: null,
  cases: [{ id: 'c1', pass: true, score: 1, ms: 1 }],
  metrics,
  ranAt: new Date().toISOString(),
  ...over,
});

describe('an experiment, from commission to one adopted variant', () => {
  beforeEach(async () => {
    factory.submitted.length = 0;
    factory.granted.length = 0;
    factory.campaigns.clear();
    await freshProject();
    const existing = await getProjectBySlug('brain-architecture');
    const brainId = existing?.id ?? (await createProject({ name: 'Brain Architecture', slug: 'brain-architecture' })).id;
    await createLayer({ projectId: brainId, name: 'Methods', orderIndex: 0 });
    await createUser({ email: 'owner@example.com', displayName: 'Owner', password: 'correct horse battery staple 1', isBrainAdmin: true });
    await setProjectRepository({ projectId: brainId, grantId: 'brain', repositoryId: 'peyday007/v5', scopeKind: 'WHOLE_REPOSITORY', pathScope: [], reason: 'test', setBy: 'test' });
    await setImprovementSwitch(true, 'owner@example.com', 'test');
  });

  async function opened() {
    const { commission } = await import('../server/services/operator/director.ts');
    const first = await commission(request() as never);
    expect(first).toMatchObject({ ok: true, intervention: 'ENGINEERING' });
    expect(first.experimentId).toBeTruthy();
    return first;
  }

  it('builds each approach to its own pull request, with no release grant, once', async () => {
    const first = await opened();
    expect(factory.submitted).toHaveLength(2);
    expect(factory.granted).toHaveLength(0);
    const objective = String(factory.submitted[0]!['objective']);
    expect(objective).toContain('Build approach "gate" ONLY');
    expect(objective).toContain('do not merge');
    expect(objective).toContain('benchmark suite "feasibility"');
    expect(objective).toContain('Hidden cases exist');
    expect(String(factory.submitted[1]!['objective'])).toContain('Build approach "retrieve" ONLY');
    expect(factory.submitted[1]!['mutationScope']).toEqual(['server/services/goals/constraints.ts', 'tests/**']);

    const rows = await listCandidates();
    const parent = rows.find((c) => c.id === first.candidateId)!;
    expect(parent.evidence['experiment']).toMatchObject({ role: 'PARENT', id: first.experimentId });
    expect(rows.map((c) => c.weaknessKey).sort()).toEqual([parent.weaknessKey, `${parent.weaknessKey}~v1`, `${parent.weaknessKey}~v2`].sort());
    expect(rows.every((c) => c.decision === null)).toBe(true);

    // The same deficiency again is the same experiment; the loop's own pass builds nothing more.
    const again = await (await import('../server/services/operator/director.ts')).commission(request({ runId: 'opr_again' }) as never);
    expect(again).toMatchObject({ ok: true, duplicate: true, experimentId: first.experimentId });
    const { advanceNow } = await import('../server/services/improvement/loop.ts');
    for (const c of await listCandidates()) await advanceNow(c.id);
    expect(factory.submitted).toHaveLength(2);
    expect(factory.granted).toHaveLength(0);
  });

  it('refuses approaches that are not alternatives, or a suite nobody registered, before recording anything', async () => {
    const { commission } = await import('../server/services/operator/director.ts');
    const same = request({ approaches: [request().approaches[0], { ...request().approaches[0], label: 'gate2' }] });
    expect((await commission(same as never)).ok).toBe(false);
    expect((await commission(request({ suite: 'vibes' }) as never)).reason).toMatch(/not registered/);
    expect(factory.submitted).toHaveLength(0);
    expect(await listCandidates()).toHaveLength(0);
  });

  it('waits for every pull request, records the evaluator, adopts the winner and releases it alone', async () => {
    const first = await opened();
    const { pendingEvaluations, recordResult, decide } = await import('../server/services/evolution/experiments.ts');
    expect(await pendingEvaluations()).toEqual([]);
    finishBuilding('fcp_for_fcr_test1', 101);
    expect(await pendingEvaluations()).toEqual([]);
    finishBuilding('fcp_for_fcr_test2', 102);
    const pending = await pendingEvaluations();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id: first.experimentId, suite: 'feasibility' });
    expect(pending[0]!.variants.map((v) => [v.label, v.pr_number, v.head_sha])).toEqual([['gate', 101, 'head101'], ['retrieve', 102, 'head102']]);
    const [gate, retrieve] = pending[0]!.variants;

    // Not every subject scored yet: the decision waits.
    expect(await recordResult({ experimentId: first.experimentId!, variantId: null, result: result({ accuracy: 0.8 }) })).toMatchObject({ ok: true });
    expect(await decide(first.experimentId!)).toMatchObject({ ok: false, verdict: 'INSUFFICIENT' });
    // A result for another suite, or a variant of another experiment, is refused.
    expect(await recordResult({ experimentId: first.experimentId!, variantId: gate!.id, result: result({ p50ms: 1 }, { suite: 'planSpeed' }) })).toMatchObject({ ok: false });
    expect(await recordResult({ experimentId: first.experimentId!, variantId: 'evv_nope', result: result({ accuracy: 1 }) })).toMatchObject({ ok: false });

    await recordResult({ experimentId: first.experimentId!, variantId: gate!.id, result: result({ accuracy: 0.97 }), linesChanged: 120 });
    await recordResult({ experimentId: first.experimentId!, variantId: retrieve!.id, result: result({ accuracy: 0.85 }), linesChanged: 30 });
    const decided = await decide(first.experimentId!);
    expect(decided).toMatchObject({ ok: true, verdict: 'ADOPT', closePullRequests: [102] });
    if (!decided.ok) throw new Error('not decided');
    expect(decided.winner).toMatchObject({ label: 'gate', prNumber: 101, release: 'automatic release granted (LOW risk)' });
    expect(factory.granted).toEqual(['fcr_test1']);

    const variants = await listVariants(first.experimentId!);
    expect(variants.map((v) => [v.label, v.state])).toEqual([['gate', 'ADOPTED'], ['retrieve', 'REJECTED']]);
    const loser = (await getCandidate(variants[1]!.candidateId!))!;
    expect(loser.decision).toBe('REJECTED');
    expect(loser.decisionReason).toMatch(/not adopted/);
    const winner = (await getCandidate(variants[0]!.candidateId!))!;
    expect(winner.decision).toBeNull();
    expect(winner.evidence['experiment']).toMatchObject({ adopted: true });
    const parent = (await getCandidate(first.candidateId!))!;
    expect(parent).toMatchObject({ decision: 'COMBINED', combinedIntoId: winner.id });
    expect((await getExperiment(first.experimentId!))).toMatchObject({ state: 'DECIDED', verdict: 'ADOPT', winnerVariantId: variants[0]!.id });

    const stats = await listApproachStats();
    expect(stats.map((s) => [s.approachType, s.capabilityClass, s.trials, s.wins])).toEqual([
      ['EVALUATION_MACHINERY', 'REASONING', 1, 1],
      ['RETRIEVAL', 'REASONING', 1, 0],
    ]);

    // Decided once: a second evaluator, a retry or a restart changes nothing.
    expect(await decide(first.experimentId!)).toMatchObject({ ok: false });
    expect(factory.granted).toHaveLength(1);

    // The verified cycle reads the comparison from these rows.
    const { alternativesFacts } = await import('../server/services/operator/director.ts');
    expect(await alternativesFacts(winner.id)).toMatchObject({ variantsEvaluated: 2, verdict: 'ADOPT', winnerCandidateId: winner.id, winnerCampaignId: 'fcp_for_fcr_test1', winnerHeadSha: 'head101' });
  });

  it('judges on the hidden cases when every subject has a hidden result, and rejects all when none beats the baseline', async () => {
    const first = await opened();
    const { pendingEvaluations, recordResult, decide } = await import('../server/services/evolution/experiments.ts');
    finishBuilding('fcp_for_fcr_test1', 201);
    finishBuilding('fcp_for_fcr_test2', 202);
    const [gate, retrieve] = (await pendingEvaluations())[0]!.variants;
    const id = first.experimentId!;
    // Public cases say the gate wins; the hidden cases the agents could not see say nothing does.
    await recordResult({ experimentId: id, variantId: null, result: result({ accuracy: 0.8 }) });
    await recordResult({ experimentId: id, variantId: gate!.id, result: result({ accuracy: 0.99 }) });
    await recordResult({ experimentId: id, variantId: retrieve!.id, result: result({ accuracy: 0.8 }) });
    await recordResult({ experimentId: id, variantId: null, result: result({ accuracy: 0.7 }), hidden: true });
    await recordResult({ experimentId: id, variantId: gate!.id, result: result({ accuracy: 0.7 }), hidden: true });
    await recordResult({ experimentId: id, variantId: retrieve!.id, result: result({ accuracy: 0.69 }, { hidden: true }) });
    const decided = await decide(id);
    expect(decided).toMatchObject({ ok: true, verdict: 'REJECTED_ALL', winner: null, closePullRequests: [201, 202] });
    expect(factory.granted).toHaveLength(0);
    expect((await getCandidate(first.candidateId!))!.decision).toBe('REJECTED');
    expect((await listCandidates()).filter((c) => c.decision === 'REJECTED')).toHaveLength(3);
  });

  it('holds an experiment that cannot compare two pull requests in its build window', async () => {
    const first = await opened();
    const { pendingEvaluations } = await import('../server/services/evolution/experiments.ts');
    finishBuilding('fcp_for_fcr_test1', 301);
    const later = new Date(Date.now() + 80 * 3_600_000);
    expect(await pendingEvaluations(later)).toEqual([]);
    expect(await getExperiment(first.experimentId!)).toMatchObject({ state: 'HELD' });
    expect((await getCandidate(first.candidateId!))!.decision).toBe('HELD');
  });

  it('turns a suite baseline that misses its target into a generic deficiency, EVIDENCE until the results state a cause', async () => {
    const { recordResult } = await import('../server/services/evolution/experiments.ts');
    const { capabilityDeficiencies } = await import('../server/services/operator/director.ts');
    expect(await capabilityDeficiencies()).toEqual([]);
    await recordResult({ experimentId: null, variantId: null, result: result({ accuracy: 0.97 }) });
    expect(await capabilityDeficiencies()).toEqual([]);
    await recordResult({ experimentId: null, variantId: null, result: result({ accuracy: 0.8 }, { ranAt: new Date(Date.now() + 1000).toISOString() }) });
    const [one] = await capabilityDeficiencies();
    expect(one).toMatchObject({ intervention: 'EVIDENCE', diagnosis: { deficiency: 'CAPABILITY_BELOW_TARGET', suite: 'feasibility' } });
    expect(one!.diagnosis.title).toContain('feasibility');
    expect(one!.diagnosis.title).toContain('accuracy');
    await recordResult({
      experimentId: null,
      variantId: null,
      result: result({ accuracy: 0.8 }, { ranAt: new Date(Date.now() + 2000).toISOString(), cause: 'the pathway builder treats open funding questions as answered constraints', ownerPaths: ['server/services/goals/plan.ts'] }),
    });
    const [two] = await capabilityDeficiencies();
    expect(two).toMatchObject({ intervention: 'ENGINEERING' });
    // A variant result belongs to an experiment.
    expect(await recordResult({ experimentId: null, variantId: 'evv_x', result: result({ accuracy: 1 }) })).toMatchObject({ ok: false });
  });

  it('keeps hidden cases in the database only, and offers the tools to Hermes', async () => {
    const { addHiddenCase, readExperiments } = await import('../server/services/evolution/experiments.ts');
    const { listHiddenCases } = await import('../server/repos/evolution.ts');
    expect(await addHiddenCase({ suite: 'feasibility', testCase: { id: 'h1', plan: { funding: 'open question' }, expected: 'INFEASIBLE' }, reason: 'seen in production', createdBy: 'operator:t' })).toMatchObject({ ok: true });
    expect((await addHiddenCase({ suite: 'feasibility', testCase: { id: 'h1' }, reason: null, createdBy: 'operator:t' })).ok).toBe(false);
    expect((await addHiddenCase({ suite: 'nope', testCase: { id: 'h2' }, reason: null, createdBy: 'operator:t' })).ok).toBe(false);
    expect((await listHiddenCases('feasibility')).map((c) => (c.case as { id: string }).id)).toEqual(['h1']);
    const read = await readExperiments();
    expect(read.hiddenCases).toEqual({ feasibility: 1 });
    expect(JSON.stringify(read)).not.toContain('open question');
    for (const name of ['brain_operator_experiments', 'brain_operator_add_hidden_case']) {
      expect(OPERATOR_TOOL_NAMES as readonly string[]).toContain(name);
      expect(findTool(name)).not.toBeNull();
      expect(operatorBrief({ nowIso: 'now', runId: 'opr_x' })).toContain(name);
    }
    const schema = findTool('brain_operator_commission')!.inputSchema as unknown as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(['approaches', 'suite']));
    const rows = await getDb().all<{ n: number }>('SELECT COUNT(*) AS n FROM evolution_hidden_cases', []);
    expect(Number(rows[0]!.n)).toBe(1);
  });
});

/**
 * Production, 2026-11-16 08:02Z: Hermes commissioned evx_f0f141e30794417c8187 for a moot-request
 * defect in the Russell loop on suite `feasibility`, which classifies plan feasibility and cannot
 * see the defect — every variant would have scored equal to the baseline and the selection would
 * have decided on nothing. A suite now declares what it measures: a misfit commission is refused
 * naming the suites that fit, and an undecided experiment already on a misfit suite is moved onto
 * the one that measures its deficiency, or held when none can.
 */
describe('an experiment is measured on a suite that can see its deficiency', () => {
  const MOOT_PATHS = ['server/services/russell/needsHuman.ts', 'server/services/russell/loop.ts'];
  const moot = (over: Record<string, unknown> = {}) =>
    request({
      deficiency: 'RECURRING_OPERATIONAL_FAILURE',
      title: 'Answered research cards come back as moot person-requests',
      observed: 'Goal reads BLOCKED on a person: open requests are moot because their missions already left NEEDS_HUMAN and no answer can apply.',
      evidence: 'rhr_1: mission rms_1 CANCELLED; 3 OPERATOR_WITHDREW_MOOT_REQUEST events in 7 days',
      cause: "russell/loop.ts 'answered-requests' passes every failed resume to reopenAnswered",
      ownerPaths: MOOT_PATHS,
      suite: 'mootRequests',
      approaches: [
        { label: 'atomic', approachType: 'ALGORITHM_REPLACEMENT', approach: 'Cancel pending answered requests atomically in the same statement that moves a mission out of NEEDS_HUMAN.', ownerPaths: ['server/repos/russellMissions.ts'] },
        { label: 'filter', approachType: 'REMOVE_WORK', approach: 'Filter resumes whose mission already left Needs You in the loop pass before they ever reach reopenAnswered.', ownerPaths: ['server/services/russell/loop.ts'] },
      ],
      ...over,
    });

  beforeEach(async () => {
    factory.submitted.length = 0;
    factory.campaigns.clear();
    await freshProject();
    const existing = await getProjectBySlug('brain-architecture');
    const brainId = existing?.id ?? (await createProject({ name: 'Brain Architecture', slug: 'brain-architecture' })).id;
    await createLayer({ projectId: brainId, name: 'Methods', orderIndex: 0 });
    await createUser({ email: 'owner@example.com', displayName: 'Owner', password: 'correct horse battery staple 1', isBrainAdmin: true });
    await setProjectRepository({ projectId: brainId, grantId: 'brain', repositoryId: 'peyday007/v5', scopeKind: 'WHOLE_REPOSITORY', pathScope: [], reason: 'test', setBy: 'test' });
    await setImprovementSwitch(true, 'owner@example.com', 'test');
  });

  it('declares, for every suite, what it measures, and finds the suites that fit a deficiency', async () => {
    const { EVOLUTION_SUITES, suiteFit, suitesFitting } = await import('../server/domain/evolutionSuites.ts');
    // Every declared suite has a runner in the harness, and every runner is declared (read from the
    // source: importing the harness would set the bench's process environment in this test's process).
    const { readFileSync } = await import('node:fs');
    const registry = /export const SUITES: Record<string, Suite> = \{([^}]*)\}/.exec(readFileSync(new URL('../bench/run.ts', import.meta.url), 'utf8'))![1]!;
    expect(EVOLUTION_SUITES.map((s) => s.name).sort()).toEqual(registry.split(',').map((x) => x.trim()).filter(Boolean).sort());
    for (const s of EVOLUTION_SUITES) expect(s.measures.deficiencies.length).toBeGreaterThan(0);
    expect(suitesFitting('RECURRING_OPERATIONAL_FAILURE', MOOT_PATHS).map((s) => s.name)).toEqual(['mootRequests']);
    expect(suitesFitting('RECURRING_OPERATIONAL_FAILURE', ['server/services/russell/**']).map((s) => s.name)).toEqual(['mootRequests']);
    // The same class on code no suite drives: nothing fits.
    expect(suitesFitting('RECURRING_OPERATIONAL_FAILURE', ['server/services/cheap/dispatch.ts'])).toEqual([]);
    expect(suitesFitting('ECONOMIC_REASONING', []).map((s) => s.name)).toEqual(['feasibility']);
    const feasibility = EVOLUTION_SUITES.find((s) => s.name === 'feasibility')!;
    expect(suiteFit(feasibility, 'RECURRING_OPERATIONAL_FAILURE', MOOT_PATHS)).toMatchObject({ fits: false });
  });

  it('refuses a commission whose suite cannot see the deficiency, naming the suite that can, before recording anything', async () => {
    const { commission } = await import('../server/services/operator/director.ts');
    const refused = await commission(moot({ suite: 'feasibility' }) as never);
    expect(refused.ok).toBe(false);
    expect(refused.reason).toMatch(/suite "feasibility" does not measure this deficiency/);
    expect(refused.reason).toMatch(/Choose a suite that does: mootRequests/);
    // Nothing measures a broken integration yet: refused with what to do instead.
    const none = await commission(moot({ deficiency: 'BROKEN_INTEGRATION', suite: 'feasibility' }) as never);
    expect(none.ok).toBe(false);
    expect(none.reason).toMatch(/no registered suite measures BROKEN_INTEGRATION/);
    expect(none.reason).toMatch(/commission it without approaches and suite/);
    expect(factory.submitted).toHaveLength(0);
    expect(await listCandidates()).toHaveLength(0);

    const opened = await commission(moot() as never);
    expect(opened).toMatchObject({ ok: true, experimentId: expect.any(String) });
    expect(await getExperiment(opened.experimentId!)).toMatchObject({ suite: 'mootRequests', capabilityClass: 'OPERATIONS' });
    expect(String(factory.submitted[0]!['objective'])).toContain('benchmark suite "mootRequests"');
  });

  it('moves an open experiment on a misfit suite onto the one that measures it, and decides only on that suite', async () => {
    const { commission } = await import('../server/services/operator/director.ts');
    const opened = await commission(moot() as never);
    const id = opened.experimentId!;
    // As production holds evx_f0f141e30794417c8187: opened on feasibility, before suites declared what they measure.
    await getDb().run(`UPDATE evolution_experiments SET suite = 'feasibility', capability_class = 'REASONING' WHERE id = ?`, [id]);
    const { pendingEvaluations, recordResult, decide } = await import('../server/services/evolution/experiments.ts');
    finishBuilding('fcp_for_fcr_test1', 401);
    finishBuilding('fcp_for_fcr_test2', 402);
    const pending = await pendingEvaluations();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id, suite: 'mootRequests' });
    expect(await getExperiment(id)).toMatchObject({ state: 'EVALUATING', suite: 'mootRequests', capabilityClass: 'OPERATIONS' });
    const events = await getDb().all<{ detail: string }>(`SELECT detail FROM improvement_events WHERE kind = 'EXPERIMENT_RETARGETED'`, []);
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.detail)).toMatchObject({ experimentId: id, from: 'feasibility', to: 'mootRequests' });
    // Moved once: another pass changes nothing.
    await pendingEvaluations();
    expect(await getDb().all(`SELECT 1 FROM improvement_events WHERE kind = 'EXPERIMENT_RETARGETED'`, [])).toHaveLength(1);

    const [atomic, filter] = pending[0]!.variants;
    const scored = (metrics: Record<string, number>) => result({ ...metrics, falseWithdraw: 0, historyLost: 0 }, { suite: 'mootRequests' });
    // A feasibility result is refused now, and the mootRequests results decide.
    expect(await recordResult({ experimentId: id, variantId: null, result: result({ accuracy: 1 }) })).toMatchObject({ ok: false });
    await recordResult({ experimentId: id, variantId: null, result: scored({ accuracy: 0.6 }) });
    await recordResult({ experimentId: id, variantId: atomic!.id, result: scored({ accuracy: 1 }) });
    await recordResult({ experimentId: id, variantId: filter!.id, result: scored({ accuracy: 0.8 }) });
    const decided = await decide(id);
    expect(decided).toMatchObject({ ok: true, verdict: 'ADOPT', winner: { label: 'atomic' }, closePullRequests: [402] });
    const stats = await listApproachStats();
    expect(stats.every((s) => s.capabilityClass === 'OPERATIONS')).toBe(true);
  });

  it('commissioning the running deficiency again on another fitting suite moves the same experiment', async () => {
    const { commission } = await import('../server/services/operator/director.ts');
    const opened = await commission(moot() as never);
    await getDb().run(`UPDATE evolution_experiments SET suite = 'feasibility' WHERE id = ?`, [opened.experimentId!]);
    const again = await commission(moot({ runId: 'opr_retarget' }) as never);
    expect(again).toMatchObject({ ok: true, duplicate: true, experimentId: opened.experimentId });
    expect(await getExperiment(opened.experimentId!)).toMatchObject({ suite: 'mootRequests' });
    expect(factory.submitted).toHaveLength(2);
  });

  it('holds a built experiment no registered suite can measure, instead of deciding on a blind score', async () => {
    const { commission } = await import('../server/services/operator/director.ts');
    const opened = await commission(moot() as never);
    const id = opened.experimentId!;
    // Its owner paths move to code no suite drives.
    const parent = (await getCandidate(opened.candidateId!))!;
    const { patchCandidate } = await import('../server/repos/improvement.ts');
    await patchCandidate(parent.id, { evidence: { ...parent.evidence, ownerPaths: ['server/services/billing/x.ts'] } });
    await getDb().run(`UPDATE evolution_variants SET owner_paths = '["server/services/billing/x.ts"]' WHERE experiment_id = ?`, [id]);
    await getDb().run(`UPDATE evolution_experiments SET suite = 'feasibility' WHERE id = ?`, [id]);
    const { pendingEvaluations, decide } = await import('../server/services/evolution/experiments.ts');
    finishBuilding('fcp_for_fcr_test1', 501);
    finishBuilding('fcp_for_fcr_test2', 502);
    // Building → evaluating on this pass; the next one finds no suite that can see it.
    await pendingEvaluations();
    expect(await pendingEvaluations()).toEqual([]);
    const held = (await getExperiment(id))!;
    expect(held.state).toBe('HELD');
    expect(held.rationale).toMatch(/no registered suite measures RECURRING_OPERATIONAL_FAILURE/);
    expect(await decide(id)).toMatchObject({ ok: false });
  });
});
