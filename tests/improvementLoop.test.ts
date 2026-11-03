/**
 * Brain improving itself (§87): one loop from weakness to measured decision.
 *
 * Production, 2026-11-03: the free lane failed 364 of 436 settled fragments in
 * a day, 1 177 accepted method claims reached workers only as prompt text, and
 * Claude routines answered NO_WORK, because nothing turned a performance record
 * or a method finding into Brain-improvement work. These pin that the rows now
 * become work for the right worker, that the work is measured against a
 * baseline, and that a failing improvement cannot loop or wake the owner.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { recordBinEvent } from '../server/repos/bins.ts';
import { createProject, getProjectBySlug } from '../server/repos/projects.ts';
import { createLayer } from '../server/repos/layers.ts';
import { createRun } from '../server/repos/runs.ts';
import { createOrchestration } from '../server/repos/research.ts';
import { createUser } from '../server/repos/identity.ts';
import { decideCandidate, getCandidateByKey, listCandidates, listImprovementEvents, patchCandidate } from '../server/repos/improvement.ts';
import {
  alertsDue,
  checkDependencies,
  classifyFreeLaneFailure,
  compare,
  decideAfterMeasurement,
  dependencyCheckFor,
  deriveStage,
  freeLaneWeaknesses,
  ownerInterventionWeaknesses,
  MAX_ATTEMPTS,
  rankCandidates,
  reading,
} from '../server/domain/improvement.ts';
import { binLane, classifyBinPurpose } from '../server/domain/binPurpose.ts';
import { improvementTick } from '../server/services/improvement/loop.ts';
import { improvementGrant, setImprovementSwitch } from '../server/services/improvement/authority.ts';
import { readMetric } from '../server/services/improvement/scoreboard.ts';
import { preflight } from '../server/domain/engineering.ts';

const FROM = '2026-11-01T00:00:00.000Z';
const TO = '2026-11-02T00:00:00.000Z';

describe('the decisions, pure', () => {
  it('classifies the free lane\'s own failure reasons', () => {
    expect(classifyFreeLaneFailure('model brain-a: no readable source among 12 candidate page(s): {"NETWORK_ERROR":12}')).toBe('NO_READABLE_SOURCE');
    expect(classifyFreeLaneFailure("model x: the answer did not survive Brain's own checks: 4 claim(s) offered")).toBe('CITATION_DROPPED');
    expect(classifyFreeLaneFailure('model x: brain_submit_claims refused: unknown lane')).toBe('SUBMISSION_REFUSED');
    expect(classifyFreeLaneFailure('model x: model call failed: cheap lane HTTP 429')).toBe('PROVIDER_EXHAUSTED');
  });

  it('turns only frequent, material failure classes into weaknesses', () => {
    const many = freeLaneWeaknesses([{ cls: 'NO_READABLE_SOURCE', n: 40, samples: ['a'] }, { cls: 'CITATION_DROPPED', n: 3, samples: [] }], 100);
    expect(many.map((w) => w.key)).toEqual(['FREE_LANE:NO_READABLE_SOURCE']);
    expect(many[0]!.scope).toBe('GENERAL');
    expect(freeLaneWeaknesses([{ cls: 'NO_READABLE_SOURCE', n: 20, samples: [] }], 1000)).toEqual([]);
  });

  it('turns a frequent kind of Needs-You request into method research, not engineering', () => {
    const found = ownerInterventionWeaknesses([{ cls: 'APPROVE_PACKET', n: 40, samples: ['x'] }, { cls: 'RARE', n: 2, samples: [] }], 100);
    expect(found.map((w) => w.key)).toEqual(['OWNER:APPROVE_PACKET']);
    expect(found[0]!.knownCause).toBeNull();
    expect(deriveStage({ decision: null, researchGoalId: null, research: null, archiveClaims: 0, knownCause: found[0]!.knownCause, changeRequestId: null, factory: null, deliveredAt: null, windowClosed: false }).owner).toBe('CLAUDE_ROUTINE');
  });

  it('says INSUFFICIENT DATA rather than inventing success', () => {
    const before = reading('FREE_LANE_FRAGMENT_PASS_RATE', FROM, TO, 3, 10);
    const after = reading('FREE_LANE_FRAGMENT_PASS_RATE', FROM, TO, 9, 10);
    expect(before.status).toBe('INSUFFICIENT_DATA');
    expect(compare(before, after).verdict).toBe('INSUFFICIENT_DATA');
  });

  it('judges a real improvement and a real regression by a test, not by eye', () => {
    const before = reading('FREE_LANE_FRAGMENT_PASS_RATE', FROM, TO, 72, 436);
    expect(compare(before, reading('FREE_LANE_FRAGMENT_PASS_RATE', FROM, TO, 160, 420)).verdict).toBe('IMPROVED');
    expect(compare(before, reading('FREE_LANE_FRAGMENT_PASS_RATE', FROM, TO, 30, 430)).verdict).toBe('REGRESSED');
    expect(compare(before, reading('FREE_LANE_FRAGMENT_PASS_RATE', FROM, TO, 75, 440)).verdict).toBe('NO_CHANGE');
  });

  it('withholds a verdict when the provider or the workload moved, not the change', () => {
    const before = reading('FREE_LANE_PASS_RATE', FROM, TO, 72, 436, undefined, { providerErrorShare: 0.1 });
    const after = reading('FREE_LANE_PASS_RATE', FROM, TO, 160, 420, undefined, { providerErrorShare: 0.5 });
    expect(compare(before, after).verdict).toBe('INSUFFICIENT_DATA');
    const small = reading('ACCEPTED_CLAIM_RATE', FROM, TO, 20, 40);
    const huge = reading('ACCEPTED_CLAIM_RATE', FROM, TO, 900, 1000);
    expect(compare(small, huge).verdict).toBe('INSUFFICIENT_DATA');
  });

  it('ranks a general, frequent weakness above a local one', () => {
    const ranked = rankCandidates([
      { id: 'a', scope: 'LOCAL' as const, severity: 'HIGH' as const, frequency: 5, denominator: 10, unlocks: false, similarShipped: false, createdAt: FROM },
      { id: 'b', scope: 'GENERAL' as const, severity: 'MEDIUM' as const, frequency: 300, denominator: 600, unlocks: true, similarShipped: false, createdAt: TO },
    ]);
    expect(ranked.map((r) => r.id)).toEqual(['b', 'a']);
    expect(ranked[0]!.why).toContain('general scope');
  });

  it('derives the stage and the worker from linked rows, never stores it', () => {
    const none = { decision: null, researchGoalId: null, research: null, archiveClaims: 0, knownCause: null, changeRequestId: null, factory: null, deliveredAt: null, windowClosed: false };
    expect(deriveStage(none)).toMatchObject({ stage: 'DIAGNOSE', owner: 'CLAUDE_ROUTINE' });
    expect(deriveStage({ ...none, archiveClaims: 3 })).toMatchObject({ stage: 'ENGINEER', owner: 'FACTORY' });
    expect(deriveStage({ ...none, researchGoalId: 'g', research: { settled: false, acceptedClaims: 0, status: 'RUNNING' } })).toMatchObject({ stage: 'RESEARCHING', owner: 'CLAUDE_ROUTINE' });
    expect(deriveStage({ ...none, changeRequestId: 'fcr', factory: { state: 'BUILDING', detail: 'x' } })).toMatchObject({ stage: 'ENGINEERING', owner: 'FACTORY' });
    expect(deriveStage({ ...none, changeRequestId: 'fcr', deliveredAt: TO, windowClosed: false })).toMatchObject({ stage: 'MEASURING', owner: 'BRAIN' });
    expect(deriveStage({ ...none, decision: 'KEPT' })).toMatchObject({ stage: 'CLOSED' });
  });

  it('refuses a material change whose dependencies are not answered', () => {
    expect(checkDependencies({ dependents: ['x'] }).complete).toBe(false);
    expect(checkDependencies({ dependents: ['x'] }).missing).toContain('Can the replacement actually perform it (measured)?');
    const full = dependencyCheckFor({ ownerComponent: 'server/services/freeLane/worker.ts', metric: 'FREE_LANE_FRAGMENT_PASS_RATE', downstreamMetric: 'ACCEPTED_CLAIM_RATE', kind: 'FREE_LANE_FAILURE' }, {});
    expect(checkDependencies(full).complete).toBe(true);
    expect(full.productionConfirmation).toContain('must not regress');
  });

  it('reverts a change that broke the larger workflow even when its own metric rose', () => {
    const up = { metric: 'FREE_LANE_FRAGMENT_PASS_RATE' as const, verdict: 'IMPROVED' as const, baseline: 0.2, after: 0.4, basis: 'z' };
    const down = { metric: 'ACCEPTED_CLAIM_RATE' as const, verdict: 'REGRESSED' as const, baseline: 0.6, after: 0.3, basis: 'z' };
    expect(decideAfterMeasurement({ primary: up, downstream: down, hoursSinceDelivery: 30 })).toMatchObject({ decision: 'REVERTED', revert: true });
    expect(decideAfterMeasurement({ primary: up, downstream: null, hoursSinceDelivery: 30 })).toMatchObject({ decision: 'KEPT', revert: false });
    const thin = { ...up, verdict: 'INSUFFICIENT_DATA' as const };
    expect(decideAfterMeasurement({ primary: thin, downstream: null, hoursSinceDelivery: 30 }).decision).toBeNull();
    expect(decideAfterMeasurement({ primary: thin, downstream: null, hoursSinceDelivery: 200 }).decision).toBe('HELD');
  });

  it('stays quiet in normal operation and raises each condition once per episode', () => {
    const now = '2026-11-03T12:00:00.000Z';
    expect(alertsDue({ now, lastImprovementWorkAt: '2026-11-03T10:00:00.000Z', actionableCandidates: 3, lastProgressAt: '2026-11-03T11:00:00.000Z', openCandidates: 3 })).toEqual([]);
    const idle = alertsDue({ now, lastImprovementWorkAt: '2026-11-02T10:00:00.000Z', actionableCandidates: 2, lastProgressAt: '2026-11-03T11:00:00.000Z', openCandidates: 2 });
    expect(idle.map((a) => a.condition)).toEqual(['IDLE_24H']);
    expect(idle[0]!.episode).toBe('2026-11-02T10:00:00.000Z');
    // Idle with nothing actionable is not a defect, and is not an alert.
    expect(alertsDue({ now, lastImprovementWorkAt: '2026-11-01T10:00:00.000Z', actionableCandidates: 0, lastProgressAt: now, openCandidates: 0 })).toEqual([]);
  });
});

describe('the dependency check is asked of every workflow change', () => {
  it('requires it when a change touches routing, and not for an unrelated file', () => {
    const routing = preflight({ objective: 'restrict a lane', changedPaths: ['server/domain/binPurpose.ts'] });
    expect(routing.dependencyCheck?.required).toBe(true);
    expect(routing.dependencyCheck?.questions).toContain('What work will be displaced?');
    expect(preflight({ objective: 'copy', changedPaths: ['client/src/App.tsx'] }).dependencyCheck).toBeNull();
  });
});

describe('the separation of worker categories (§84, §85, §87)', () => {
  it('sends Brain method research and Brain-repository engineering to Claude routines, commercial research to the free lane', () => {
    const brain = classifyBinPurpose({ kind: 'RESEARCH', title: 'Improve: free-lane sources', objective: 'x', project: { slug: 'brain-architecture', purpose: 'TECHNICAL' } });
    const factory = classifyBinPurpose({ kind: 'FACTORY_UNIT', title: 'u', objective: 'x', repositoryId: 'peyday007/v5', project: null });
    const play = classifyBinPurpose({ kind: 'RESEARCH', title: 'Buyers for shared mailers', objective: 'x', project: { slug: 'cash', purpose: 'PRODUCT' } });
    expect(brain.purpose).toBe('BRAIN_IMPROVEMENT');
    expect(factory.purpose).toBe('BRAIN_IMPROVEMENT');
    expect(binLane(play.purpose, true, true)).toBe('FREE_LANE');
    expect(binLane(brain.purpose, true, true)).toBe('CLAUDE');
  });

  it('approves engineering on the standing order only for Brain\'s own repository', async () => {
    await freshProject();
    expect(await improvementGrant('https://github.com/Peyday007/V5')).toMatchObject({ ok: true });
    expect(await improvementGrant('https://github.com/someone/else')).toMatchObject({ ok: false });
  });
});

describe('the loop on real rows', () => {
  let brainId = '';

  beforeEach(async () => {
    await freshProject();
    const existing = await getProjectBySlug('brain-architecture');
    brainId = existing?.id ?? (await createProject({ name: 'Brain Architecture', slug: 'brain-architecture' })).id;
    await createLayer({ projectId: brainId, name: 'Methods', orderIndex: 0 });
    await createUser({ email: 'owner@example.com', displayName: 'Owner', password: 'correct horse battery staple 1', isBrainAdmin: true });
  });

  async function failures(n: number, reason: string, ok = 0): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      await recordBinEvent({ eventType: 'FREE_LANE_ITEM', workloadClass: 'RESEARCH_FRAGMENT', outcome: 'FAILED_RETRYABLE', reason, evidenceClass: 'MEASURED' });
    }
    for (let i = 0; i < ok; i += 1) {
      await recordBinEvent({ eventType: 'FREE_LANE_ITEM', workloadClass: 'RESEARCH_FRAGMENT', outcome: 'SUBMITTED', reason: 'model a', evidenceClass: 'MEASURED' });
    }
  }

  it('reads the scoreboard from rows, with its denominator', async () => {
    await failures(20, 'model a: no readable source among 6 candidate page(s)', 10);
    const now = new Date();
    const pass = await readMetric('FREE_LANE_FRAGMENT_PASS_RATE', new Date(now.getTime() - 3_600_000).toISOString(), new Date(now.getTime() + 1000).toISOString());
    expect(pass).toMatchObject({ numerator: 10, denominator: 30, status: 'MEASURED' });
    expect(pass.value).toBeCloseTo(1 / 3, 3);
  });

  it('does not count a packet Brain cancelled as a research job that failed', async () => {
    const at = new Date().toISOString();
    const layerId = (await createLayer({ projectId: brainId, name: 'Packets', orderIndex: 1 })).id;
    const ids: string[] = [];
    for (const [status, n] of [['COMPLETE', 2], ['CANCELLED', 5], ['FAILED', 1]] as const) {
      for (let i = 0; i < n; i += 1) {
        const run = await createRun({ projectId: brainId, layerId, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: `p${status}${i}` });
        const o = await createOrchestration({ projectId: brainId, layerId, runId: run.id, title: 't', assignment: 'a', provider: 'WORKER', autoApprove: false });
        await getDb().run(
          'UPDATE research_orchestrations SET status = ?, completed_at = ?, failed_at = ?, cancelled_at = ?, updated_at = ? WHERE id = ?',
          [status, status === 'COMPLETE' ? at : null, status === 'FAILED' ? at : null, status === 'CANCELLED' ? at : null, at, o.id],
        );
        ids.push(o.id);
      }
    }
    expect(ids.length).toBe(8);
    const success = await readMetric('RESEARCH_JOB_SUCCESS_RATE', new Date(Date.now() - 3_600_000).toISOString(), new Date(Date.now() + 1000).toISOString());
    expect(success).toMatchObject({ numerator: 2, denominator: 3, context: { cancelled: 5 } });
  });

  it('turns an empty improvement queue into genuine Brain work when the rows justify it, once', async () => {
    await failures(30, 'model a: brain_submit_claims refused: evidence_lane is not a declared lane id', 5);
    const first = await improvementTick(new Date(Date.now() + 1000));
    expect(first.opened).toEqual(['FREE_LANE:SUBMISSION_REFUSED']);
    const candidate = await getCandidateByKey('FREE_LANE:SUBMISSION_REFUSED');
    // No cause in the rows and nothing in the archive: method research, which is a Claude routine's.
    expect(candidate?.researchGoalId).toBeTruthy();
    const goal = await getDb().get<{ project_id: string; purpose: string; research_assignment: string }>(
      'SELECT project_id, purpose, research_assignment FROM russell_goals WHERE id = ?',
      [candidate!.researchGoalId],
    );
    expect(goal).toMatchObject({ project_id: brainId, purpose: 'RESEARCH_GOAL' });
    expect(goal!.research_assignment).toContain('evidence_lane is not a declared lane id');
    // A second pass creates nothing new: one weakness, one candidate, one research goal.
    await improvementTick(new Date(Date.now() + 2000));
    expect((await listCandidates()).length).toBe(1);
    const goals = await getDb().get<{ n: number }>("SELECT COUNT(*) AS n FROM russell_goals WHERE purpose = 'RESEARCH_GOAL'", []);
    expect(Number(goals?.n)).toBe(1);
    expect((await listImprovementEvents({ kinds: ['RESEARCH_OPENED'] })).length).toBe(1);
  });

  it('makes no work and no alert when nothing is weak', async () => {
    await failures(2, 'model a: no readable source among 1 candidate page(s)', 50);
    const report = await improvementTick(new Date(Date.now() + 1000));
    expect(report).toMatchObject({ detected: 0, opened: [], alerts: [] });
    const asks = await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM russell_human_requests', []);
    expect(Number(asks?.n)).toBe(0);
  });

  it('does nothing while the owner\'s switch is off', async () => {
    await setImprovementSwitch(false, 'owner@example.com', 'test');
    await failures(30, 'model a: brain_submit_claims refused: x', 0);
    expect(await improvementTick(new Date(Date.now() + 1000))).toMatchObject({ ran: false, reason: 'switched off' });
    expect(await listCandidates()).toEqual([]);
  });

  it('bounds a weakness that keeps failing to MAX_ATTEMPTS attempts', async () => {
    await failures(30, 'model a: brain_submit_claims refused: x', 0);
    const later = (hours: number) => new Date(Date.now() + hours * 3_600_000);
    await improvementTick(later(0));
    for (let attempt = 1; attempt <= MAX_ATTEMPTS + 1; attempt += 1) {
      for (const open of await listCandidates({ open: true })) {
        await decideCandidate(open.id, 'REJECTED', 'test: research found nothing');
        await getDb().run('UPDATE improvement_candidates SET updated_at = ? WHERE id = ?', ['2026-01-01T00:00:00.000Z', open.id]);
      }
      // The failures are still there, so each pass may open the next attempt — never more than the bound.
      await failures(30, 'model a: brain_submit_claims refused: x', 0);
      await improvementTick(later(0.001 * attempt));
    }
    const all = await listCandidates();
    expect(all.length).toBe(MAX_ATTEMPTS);
    expect(all.map((c) => c.attempt).sort()).toEqual([1, 2, 3]);
  });

  it('combines a second weakness on the same owner into the first rather than racing it', async () => {
    await failures(30, 'model a: brain_submit_claims refused: x', 0);
    await improvementTick(new Date(Date.now() + 1000));
    await failures(30, 'model a: the answer returned no usable JSON', 0);
    await improvementTick(new Date(Date.now() + 2000));
    const second = await getCandidateByKey('FREE_LANE:NO_USABLE_ANSWER');
    expect(second?.decision).toBe('COMBINED');
    const first = await getCandidateByKey('FREE_LANE:SUBMISSION_REFUSED');
    expect(first?.evidence['combined']).toEqual(['FREE_LANE:NO_USABLE_ANSWER']);
    expect(second?.combinedIntoId).toBe(first?.id);
  });

  it('measures a delivered change against its baseline and decides once', async () => {
    await failures(30, 'model a: brain_submit_claims refused: x', 0);
    await improvementTick(new Date(Date.now() + 1000));
    const candidate = (await getCandidateByKey('FREE_LANE:SUBMISSION_REFUSED'))!;
    const deliveredAt = new Date(Date.now() - 30 * 3_600_000).toISOString();
    await patchCandidate(candidate.id, {
      changeRequestId: 'fcr_test',
      deliveredAt,
      deliveredRef: 'abc123',
      baseline: { primary: reading('FREE_LANE_FRAGMENT_PASS_RATE', FROM, TO, 5, 100), downstream: null },
    });
    // After delivery: mostly accepted.
    await failures(10, 'model a: brain_submit_claims refused: x', 90);
    const report = await improvementTick(new Date(Date.now() + 1000));
    expect(report.decided).toContain('FREE_LANE:SUBMISSION_REFUSED KEPT');
    const decided = (await getCandidateByKey('FREE_LANE:SUBMISSION_REFUSED'))!;
    expect(decided.decision).toBe('KEPT');
    expect((decided.result as { primary: { verdict: string } }).primary.verdict).toBe('IMPROVED');
  });
});
