/**
 * The abandoned-rounds diagnosis (dfx_2b21d109a13d) is a research report, and
 * a report is only as good as its weakest claim: every claim must name its
 * source and a failure class from the fixed TRAIL/MAST list, and both of the
 * operator's questions must carry an answer and the claims behind it.
 *
 * A claim is either a FAILURE_POINT — evidence, from the repository, of how
 * these rounds end, carrying the one class it evidences — or CONTEXT (the
 * literature, or a description of where work is routed), which carries no
 * class, so a count of claims per class counts only evidence about the rounds.
 * Literature cannot say how Brain's rounds ended, so a claim sourced outside
 * the repository is always CONTEXT. And every class the bypass answer says
 * method research does or does not escape must be backed by a cited
 * repository claim of that class.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { cashEventsOfKindInProject } from '../server/repos/cashMode.ts';
import { listRounds } from '../server/repos/cashDiscovery.ts';
import { launchMission, transitionMission } from '../server/repos/russellMissions.ts';
import { createBin, getBin } from '../server/repos/bins.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import * as discovery from '../server/services/cash/discovery.ts';
import {
  ABANDONED_FAILURE_CLASSES,
  abandonedFailureClass,
  ABANDONED_DIAGNOSIS_EVENT,
  diagnoseAbandonedRounds,
  harvest,
  openDiscovery,
  runDiscovery,
} from '../server/services/cash/discovery.ts';

const FAILURE_CLASSES = [
  'TRAIL_API_ERROR',
  'TRAIL_TIMEOUT',
  'TRAIL_RESOURCE_EXHAUSTION',
  'TRAIL_CONFIGURATION',
  'TRAIL_FORMATTING',
  'TRAIL_CONTEXT_HANDLING',
  'MAST_SYSTEM_DESIGN',
  'MAST_TASK_VERIFICATION',
  'SOURCE_UNREACHABLE',
  'ROUND_SETTLEMENT',
  'ROUND_CAP_LOGIC',
  'UNATTRIBUTED',
] as const;

const QUESTIONS = ['Q1_FAILURE_POINT', 'Q2_METHOD_RESEARCH_BYPASS'] as const;
const REPOSITORY = 'https://github.com/Peyday007/V5/';

interface Claim {
  id: string;
  kind: 'FAILURE_POINT' | 'CONTEXT';
  text: string;
  sourceUrl: string;
  failureClass: string | null;
}
interface Question {
  id: string;
  question: string;
  answer: string;
  claimIds: string[];
  /** Q2 only: the classes method research escapes, and the ones it still meets. */
  bypasses?: string[];
  doesNotBypass?: string[];
}
interface Report {
  deficiency: string;
  pinnedCommit: string;
  method?: string;
  limits?: string[];
  classifiedBy?: { query: string; classifier: string; classes: string; module: string; event: string; eventFields: string[] };
  failureClasses: string[];
  questions: Question[];
  claims: Claim[];
}

/** Every problem with a report, empty when it is acceptable. Pure. */
function problems(report: Report): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  for (const claim of report.claims ?? []) {
    if (ids.has(claim.id)) out.push(`${claim.id}: duplicate id`);
    ids.add(claim.id);
    if (!claim.text?.trim()) out.push(`${claim.id}: empty text`);
    if (typeof claim.sourceUrl !== 'string' || !/^https:\/\/\S+$/.test(claim.sourceUrl)) out.push(`${claim.id}: no sourceUrl`);
    if (claim.kind === 'FAILURE_POINT') {
      if (!(FAILURE_CLASSES as readonly string[]).includes(claim.failureClass ?? '')) out.push(`${claim.id}: unknown failure class ${String(claim.failureClass)}`);
      if (typeof claim.sourceUrl === 'string' && !claim.sourceUrl.startsWith(REPOSITORY)) out.push(`${claim.id}: a failure point sourced outside the repository`);
    } else if (claim.kind === 'CONTEXT') {
      if (claim.failureClass !== null) out.push(`${claim.id}: context carries failure class ${String(claim.failureClass)}`);
    } else out.push(`${claim.id}: unknown kind ${String(claim.kind)}`);
  }
  const byId = new Map((report.claims ?? []).map((claim) => [claim.id, claim]));
  if (ids.size === 0) out.push('no claims');
  for (const q of QUESTIONS) {
    const answered = (report.questions ?? []).find((one) => one.id === q);
    if (!answered || !answered.answer?.trim()) {
      out.push(`${q}: no answer`);
      continue;
    }
    if (!answered.claimIds?.length) out.push(`${q}: no supporting claims`);
    for (const id of answered.claimIds ?? []) if (!ids.has(id)) out.push(`${q}: cites unknown claim ${id}`);
  }
  const bypass = (report.questions ?? []).find((one) => one.id === 'Q2_METHOD_RESEARCH_BYPASS');
  if (bypass) {
    const asserted = [...(bypass.bypasses ?? []), ...(bypass.doesNotBypass ?? [])];
    if (!bypass.doesNotBypass) out.push('Q2_METHOD_RESEARCH_BYPASS: does not say which classes it does not bypass');
    for (const cls of asserted) {
      if (!(FAILURE_CLASSES as readonly string[]).includes(cls)) out.push(`Q2_METHOD_RESEARCH_BYPASS: unknown failure class ${cls}`);
      const backed = (bypass.claimIds ?? []).some((id) => {
        const claim = byId.get(id);
        return claim?.kind === 'FAILURE_POINT' && claim.failureClass === cls;
      });
      if (!backed) out.push(`Q2_METHOD_RESEARCH_BYPASS: ${cls} asserted without a cited repository claim`);
    }
  }
  return out;
}

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/research/abandonedRoundsDiagnosis.json', import.meta.url)), 'utf8'),
) as Report;

describe('abandoned research rounds diagnosis', () => {
  it('is the report for dfx_2b21d109a13d at the pinned commit', () => {
    expect(fixture.deficiency).toBe('dfx_2b21d109a13d');
    expect(fixture.pinnedCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('declares exactly the fixed failure classes', () => {
    expect([...fixture.failureClasses].sort()).toEqual([...FAILURE_CLASSES].sort());
  });

  it('has a sourced, classified claim behind every answer', () => {
    expect(problems(fixture)).toEqual([]);
  });

  it('cites repository claims only at the pinned commit', () => {
    for (const claim of fixture.claims) {
      if (claim.sourceUrl.startsWith('https://github.com/')) {
        expect(claim.sourceUrl, claim.id).toContain(`/blob/${fixture.pinnedCommit}/`);
      }
    }
  });

  it('refuses a claim without a sourceUrl', () => {
    const broken: Report = { ...fixture, claims: fixture.claims.map((c, i) => (i === 0 ? { ...c, sourceUrl: '' } : c)) };
    expect(problems(broken)).toContain(`${fixture.claims[0]!.id}: no sourceUrl`);
  });

  it('refuses an unknown failure class', () => {
    const broken: Report = { ...fixture, claims: fixture.claims.map((c, i) => (i === 0 ? { ...c, failureClass: 'VIBES' } : c)) };
    expect(problems(broken)).toContain(`${fixture.claims[0]!.id}: unknown failure class VIBES`);
  });

  it('refuses a literature claim tagged as a failure point of these rounds', () => {
    const literature = fixture.claims.find((c) => !c.sourceUrl.startsWith(REPOSITORY))!;
    const broken: Report = {
      ...fixture,
      claims: fixture.claims.map((c) => (c.id === literature.id ? { ...c, kind: 'FAILURE_POINT', failureClass: 'TRAIL_API_ERROR' } : c)),
    };
    expect(problems(broken)).toContain(`${literature.id}: a failure point sourced outside the repository`);
  });

  it('refuses a context claim that carries a failure class', () => {
    const context = fixture.claims.find((c) => c.kind === 'CONTEXT')!;
    const broken: Report = { ...fixture, claims: fixture.claims.map((c) => (c.id === context.id ? { ...c, failureClass: 'MAST_SYSTEM_DESIGN' } : c)) };
    expect(problems(broken)).toContain(`${context.id}: context carries failure class MAST_SYSTEM_DESIGN`);
  });

  it('refuses a bypass verdict on a class no cited repository claim backs', () => {
    for (const cls of ['MAST_TASK_VERIFICATION', 'SOURCE_UNREACHABLE']) {
      const broken: Report = {
        ...fixture,
        questions: fixture.questions.map((q) =>
          q.id === 'Q2_METHOD_RESEARCH_BYPASS'
            ? { ...q, claimIds: q.claimIds.filter((id) => fixture.claims.find((c) => c.id === id)?.failureClass !== cls) }
            : q,
        ),
      };
      expect(problems(broken)).toContain(`Q2_METHOD_RESEARCH_BYPASS: ${cls} asserted without a cited repository claim`);
    }
  });

  it('says which classes method research still meets', () => {
    const q2 = fixture.questions.find((q) => q.id === 'Q2_METHOD_RESEARCH_BYPASS')!;
    expect(q2.doesNotBypass).toEqual(expect.arrayContaining(['MAST_TASK_VERIFICATION', 'SOURCE_UNREACHABLE']));
  });

  it('refuses an empty answer to either question', () => {
    for (const q of QUESTIONS) {
      const broken: Report = { ...fixture, questions: fixture.questions.map((one) => (one.id === q ? { ...one, answer: '  ' } : one)) };
      expect(problems(broken)).toContain(`${q}: no answer`);
    }
  });
});

/*
 * The report above was answered from code paths, and the reviewer's finding was
 * that nothing in Brain could classify the abandoned rounds themselves: the
 * report's taxonomy lived only in a fixture, and the operator had no query to
 * run over production rows. These pin the production side — the report's
 * classes are the code's, its stated limit is kept, and the rounds of a real
 * project are classified from their own rows, including a round closed before
 * causes were recorded.
 */
describe('the abandoned rounds are classified by Brain, not only by the report', () => {
  it("holds the report to production's classes and names the production query that closes its limit", () => {
    expect([...fixture.failureClasses].sort()).toEqual([...ABANDONED_FAILURE_CLASSES].sort());
    expect([...FAILURE_CLASSES].sort()).toEqual([...ABANDONED_FAILURE_CLASSES].sort());
    const by = fixture.classifiedBy!;
    expect(by).toBeDefined();
    const exported = discovery as unknown as Record<string, unknown>;
    expect(typeof exported[by.query]).toBe('function');
    expect(typeof exported[by.classifier]).toBe('function');
    expect(exported[by.classes]).toEqual(ABANDONED_FAILURE_CLASSES);
    expect(by.eventFields).toEqual(expect.arrayContaining(['cause', 'failureClass']));
    // The limit stays stated: the report never read the rounds, so it claims no count.
    expect(fixture.method).toMatch(/not readable/);
    expect(fixture.limits?.length).toBeGreaterThan(0);
  });

  it('sorts each cause the operator named into its own class, and an unstated one into none', () => {
    expect(abandonedFailureClass('MISSION_FAILED:worker lease expired: API timeout after 20000 ms')).toBe('TRAIL_TIMEOUT');
    expect(abandonedFailureClass('MISSION_FAILED:submission refused: claims JSON did not parse')).toBe('TRAIL_FORMATTING');
    expect(abandonedFailureClass('MISSION_FAILED:prompt is too long: maximum context length exceeded')).toBe('TRAIL_CONTEXT_HANDLING');
    expect(abandonedFailureClass('MISSION_FAILED:provider returned 429 rate limit')).toBe('TRAIL_API_ERROR');
    expect(abandonedFailureClass('MISSION_FAILED:source unreachable: ENOTFOUND example.test')).toBe('SOURCE_UNREACHABLE');
    expect(abandonedFailureClass('MISSION_FAILED:No fragment cleared its evidence gate.')).toBe('MAST_TASK_VERIFICATION');
    expect(abandonedFailureClass('ROUND_CAP_UNLAUNCHED_6H')).toBe('ROUND_CAP_LOGIC');
    expect(abandonedFailureClass('ARCHIVE_ANSWERED')).toBe('ROUND_SETTLEMENT');
    expect(abandonedFailureClass('MISSION_NEEDS_HUMAN:a login only the owner holds')).toBe('ROUND_SETTLEMENT');
    expect(abandonedFailureClass('MISSION_CANCELLED:cancelled by operator')).toBe('ROUND_SETTLEMENT');
    expect(abandonedFailureClass('MISSION_FAILED:UNSTATED')).toBe('UNATTRIBUTED');
    for (const cause of ['MISSION_FAILED:anything at all', 'ARCHIVE_ANSWERED', 'MISSION_FAILED:UNSTATED']) {
      expect(ABANDONED_FAILURE_CLASSES).toContain(abandonedFailureClass(cause));
    }
  });

  describe('over a real project', () => {
    let projectId = '';
    let seq = 0;

    beforeEach(async () => {
      const fixtureProject = await freshProject();
      projectId = fixtureProject.project.id;
      const user = await createUser({
        email: `diagnosis-${Math.random().toString(36).slice(2, 10)}@example.test`,
        displayName: 'Owner',
        password: 'correct horse battery staple',
      });
      const outcome = await activate({
        projectId,
        ownerUserId: user.id,
        actorUserId: user.id,
        objective: 'Maximize additional usable cash over the next few weeks.',
      });
      expect(outcome.ok).toBe(true);
    });

    async function failed(candidateId: string, terminalReason: string | null): Promise<void> {
      seq += 1;
      const { mission } = await launchMission({
        projectId,
        visibility: 'SHARED',
        objective: 'a discovery bucket',
        whyNow: 'the sprint is active',
        idempotencyKey: `diagnosis-${candidateId}-${seq}`,
        candidateId,
      });
      await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
      await transitionMission({ missionId: mission.id, from: 'RUNNING', to: 'FAILED', terminalReason });
    }

    it('closes a round whose mission is parked as a legal call, leaving the mission and its bin where they are (production cdr_fbb0fd60)', async () => {
      const [legalRound] = await openDiscovery({ projectId, limit: 1 });
      expect(legalRound).toBeTruthy();
      seq += 1;
      const { mission } = await launchMission({
        projectId, visibility: 'SHARED', objective: 'a discovery bucket', whyNow: 'the sprint is active',
        idempotencyKey: `legal-${legalRound!.candidateId}-${seq}`, candidateId: legalRound!.candidateId,
      });
      await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
      const bin = await createBin({
        projectId, kind: 'RESEARCH_PACKET', title: 'a legal question', objective: 'q', completionContract: 'RESEARCH_PACKET_V1',
        createdByType: 'SYSTEM', createdById: 'test', ready: true,
        manifest: {
          objective: 'q', why: 'q', lineage: { projectId, layerId: null, goal: null, orchestrationId: null }, units: [],
          acceptableSources: ['a'], excludedSources: ['b'], evidence: ['c'], outputs: ['d'], authorizedActions: ['e'], prohibitedActions: ['f'],
          budgetUnits: 1, retry: { maxAttempts: 3, backoffSeconds: 30 }, stoppingConditions: ['g'],
        },
      });
      await getDb().run('UPDATE bins SET purpose = ? WHERE id = ?', ['BLOCKED_LEGAL', bin.id]);
      await getDb().run('UPDATE russell_missions SET bin_id = ? WHERE id = ?', [bin.id, mission.id]);

      await harvest({ projectId, limit: 50 });

      const round = (await listRounds(projectId)).find((r) => r.bucketId === legalRound!.bucketId)!;
      expect(round.state).toBe('ABANDONED');
      const stop = (await cashEventsOfKindInProject(projectId, 'CASH_DISCOVERY_ROUND_STOPPED'))
        .map((e) => e.detail as Record<string, unknown>).find((d) => d.roundId === round.id)!;
      expect(stop).toMatchObject({ cause: 'BIN_PARKED_LEGAL', failureClass: 'ROUND_SETTLEMENT', missionState: 'RUNNING' });
      // Nothing about the parked work is changed: it waits for its person.
      expect((await getDb().get<{ state: string }>('SELECT state FROM russell_missions WHERE id = ?', [mission.id]))!.state).toBe('RUNNING');
      expect((await getBin(bin.id))!.state).toBe(bin.state);
    });

    it('classifies every ABANDONED round from its rows, recording the class on the stop event and reconstructing an older one', async () => {
      const opened = await openDiscovery({ projectId, limit: 5 });
      expect(opened.length).toBeGreaterThanOrEqual(5);
      const [timeout, parse, gate, silent, archive] = opened as [
        (typeof opened)[number], (typeof opened)[number], (typeof opened)[number], (typeof opened)[number], (typeof opened)[number],
      ];
      await failed(timeout.candidateId, 'worker lease expired: API timeout after 20000 ms');
      await failed(parse.candidateId, 'submission refused: claims JSON did not parse');
      await failed(gate.candidateId, 'No fragment cleared its evidence gate.');
      await failed(silent.candidateId, null);
      await getDb().run('UPDATE russell_candidates SET state = ? WHERE id = ?', ['REJECTED', archive.candidateId]);

      await harvest({ projectId, limit: 50 });

      const rounds = await listRounds(projectId);
      const roundOf = (one: { bucketId: string }) => rounds.find((r) => r.bucketId === one.bucketId)!;
      for (const one of [timeout, parse, gate, silent, archive]) expect(roundOf(one).state).toBe('ABANDONED');

      // The stop event the operator reads carries the class, not only the cause.
      const events = await cashEventsOfKindInProject(projectId, 'CASH_DISCOVERY_ROUND_STOPPED');
      const detailOf = (one: { bucketId: string }) =>
        events.map((e) => e.detail as Record<string, unknown>).find((d) => d.roundId === roundOf(one).id)!;
      expect(detailOf(timeout).failureClass).toBe('TRAIL_TIMEOUT');
      expect(detailOf(archive).failureClass).toBe('ROUND_SETTLEMENT');

      // A round closed before causes were recorded: its event carries neither.
      const legacy = events.find((e) => (e.detail as Record<string, unknown>).roundId === roundOf(parse).id)!;
      const stripped = { ...(legacy.detail as Record<string, unknown>) };
      delete stripped.cause;
      delete stripped.failureClass;
      await getDb().run('UPDATE cash_events SET detail = ? WHERE id = ?', [JSON.stringify(stripped), legacy.id]);

      const diagnosis = await diagnoseAbandonedRounds(projectId);
      expect(diagnosis.total).toBe(rounds.filter((r) => r.state === 'ABANDONED').length);
      const byRound = new Map(diagnosis.rounds.map((r) => [r.roundId, r]));
      expect(byRound.get(roundOf(timeout).id)).toMatchObject({ failureClass: 'TRAIL_TIMEOUT', source: 'EVENT' });
      expect(byRound.get(roundOf(parse).id)).toMatchObject({
        failureClass: 'TRAIL_FORMATTING',
        source: 'RECONSTRUCTED',
        cause: 'MISSION_FAILED:submission refused: claims JSON did not parse',
      });
      expect(byRound.get(roundOf(gate).id)!.failureClass).toBe('MAST_TASK_VERIFICATION');
      expect(byRound.get(roundOf(silent).id)!.failureClass).toBe('UNATTRIBUTED');
      expect(byRound.get(roundOf(archive).id)!.failureClass).toBe('ROUND_SETTLEMENT');
      expect(Object.values(diagnosis.byClass).reduce((a, b) => a + b, 0)).toBe(diagnosis.total);
      expect(diagnosis.byClass.TRAIL_TIMEOUT).toBeGreaterThanOrEqual(1);
    });

    it('the discovery tick records the count by class as a cash event, including a round closed before causes were recorded, once per change', async () => {
      const opened = await openDiscovery({ projectId, limit: 2 });
      expect(opened.length).toBeGreaterThanOrEqual(2);
      const [timeout, parse] = opened as [(typeof opened)[number], (typeof opened)[number]];
      await failed(timeout.candidateId, 'worker lease expired: API timeout after 20000 ms');
      await failed(parse.candidateId, 'submission refused: claims JSON did not parse');
      await harvest({ projectId, limit: 50 });

      // The parse round is one of the historical rounds: its stop event carries no cause.
      const rounds = await listRounds(projectId);
      const parseRound = rounds.find((r) => r.bucketId === parse.bucketId)!;
      const legacy = (await cashEventsOfKindInProject(projectId, 'CASH_DISCOVERY_ROUND_STOPPED')).find(
        (e) => (e.detail as Record<string, unknown>).roundId === parseRound.id,
      )!;
      const stripped = { ...(legacy.detail as Record<string, unknown>) };
      delete stripped.cause;
      delete stripped.failureClass;
      await getDb().run('UPDATE cash_events SET detail = ? WHERE id = ?', [JSON.stringify(stripped), legacy.id]);

      // Nothing had written the diagnosis before the production tick ran.
      expect(await cashEventsOfKindInProject(projectId, ABANDONED_DIAGNOSIS_EVENT)).toHaveLength(0);
      const tick = await runDiscovery(projectId);
      expect(tick.failures).toEqual([]);

      const written = await cashEventsOfKindInProject(projectId, ABANDONED_DIAGNOSIS_EVENT);
      expect(written).toHaveLength(1);
      const detail = written[0]!.detail as {
        total: number;
        byClass: Record<string, number>;
        reconstructed: number;
        reconstructedRounds: { roundId: string; cause: string; failureClass: string }[];
      };
      const expected = await diagnoseAbandonedRounds(projectId);
      expect(detail.total).toBe(expected.total);
      expect(detail.byClass).toEqual(expected.byClass);
      expect(detail.byClass.TRAIL_TIMEOUT).toBeGreaterThanOrEqual(1);
      expect(detail.byClass.TRAIL_FORMATTING).toBeGreaterThanOrEqual(1);
      expect(detail.reconstructedRounds).toContainEqual({
        roundId: parseRound.id,
        cause: 'MISSION_FAILED:submission refused: claims JSON did not parse',
        failureClass: 'TRAIL_FORMATTING',
      });
      expect(written[0]!.summary).toContain('TRAIL_TIMEOUT');

      // A tick that closes nothing new writes no second diagnosis.
      await runDiscovery(projectId);
      expect(await cashEventsOfKindInProject(projectId, ABANDONED_DIAGNOSIS_EVENT)).toHaveLength(1);
    });
  });
});
