/**
 * Discovery buckets are search methods, and closed rounds are their runs (F3).
 *
 * The lifecycle, failure classification, routing, comparison and report
 * modules had no caller outside tests: a bucket that kept failing was asked
 * again on every cool-off, and no command printed the search report. These
 * walk the production entry points — `openDiscovery`, `harvest` and the report
 * terminal — against a real database.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Layer, OpportunitySignal } from '../server/domain/types.ts';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, currentFragments, decideClaim, insertClaims, updateFragment } from '../server/repos/research.ts';
import { launchMission, linkMission, transitionMission } from '../server/repos/russellMissions.ts';
import { createSearchMethod, listMethodComparisons, listMethodRuns, listSearchMethods } from '../server/repos/searchMethods.ts';
import { bucketGates, outcomeOfRound, recordRoundAsRun } from '../server/services/research/searchMethods/bucketMethods.ts';
import { FAILURE_STREAK } from '../server/services/research/searchFailures/classify.ts';
import { runSearchCli } from '../server/services/research/searchReport/cli.ts';
import { SEARCH_BUCKETS, SIGNAL_LANE, harvest, openDiscovery } from '../server/services/cash/discovery.ts';
import { activate } from '../server/services/cash/lifecycle.ts';

let projectId = '';
let userId = '';
let layer: Layer;

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layer = await fixture.layerByName('Discovery Logic');
  const user = await createUser({
    email: `bucket-method-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner', password: 'correct horse battery staple',
  });
  userId = user.id;
});

async function oneMission(candidateId: string, claim: string): Promise<void> {
  const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'a bucket' });
  const o = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title: 'a bucket', assignment: 'where to look', provider: 'WORKER', autoApprove: false });
  await createFragments([{
    orchestrationId: o.id, projectId, layerId: layer.id, geography: 'the markets the sprint may look at',
    requiredEvidence: [{ id: SIGNAL_LANE, description: 'a published request', necessity: 'REQUIRED' }],
    acceptableSourceTypes: ['a listing'], excludedSourceTypes: ['a forecast'], completionCriteria: ['one dated request'],
    minIndependentSources: 1, maxRepairs: 2, fragmentIndex: 0, fragmentKey: 'cash-discovery',
    question: 'Who is publicly asking to pay for work right now?', dependsOn: [], attempt: 1,
  }] as unknown as Parameters<typeof createFragments>[0]);
  const [fragment] = await currentFragments(o.id);
  await updateFragment(fragment!.id, { status: 'ACCEPTED', completedAt: new Date().toISOString(), blockedReason: null });
  const [row] = await insertClaims([{
    orchestrationId: o.id, fragmentId: fragment!.id, passId: null, passKey: 'BROAD_SCAN' as const, claim,
    sourceUrl: 'https://example.test/rfp/learned', sourceTitle: 'A listing', sourcePublisher: 'A marketplace',
    sourceDate: '2026-09-10', evidenceExcerpt: claim, evidenceLocator: 'the listing body', evidenceLane: SIGNAL_LANE,
    opportunitySignal: 'EXPIRING_OPENING' as OpportunitySignal, closesOn: null, retrievedAt: '2026-09-12', confidence: 0.8,
    validationState: 'SOURCED' as const, validationDetail: null, sourced: true, claimType: 'SOURCED_FACT' as const,
    contentHash: `${claim}|x`,
  }]);
  await decideClaim(row!.id, { accepted: true });
  const { mission } = await launchMission({ projectId, layerId: layer.id, visibility: 'SHARED', objective: 'a bucket', whyNow: 'active', idempotencyKey: `mission:${o.id}`, candidateId });
  await linkMission({ missionId: mission.id, orchestrationId: o.id });
  await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
  await transitionMission({ missionId: mission.id, from: 'RUNNING', to: 'DONE', terminalReason: null, waitingOn: null });
}

const reader = () => ({ projectIds: [projectId], userId: null });

describe('a closed discovery round is a run of its bucket\'s method', () => {
  it('records the bucket as a PROJECT method and the round as a FOUND run when harvest closes it', async () => {
    const outcome = await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash.' });
    expect(outcome.ok).toBe(true);
    const [first] = await openDiscovery({ projectId });
    await oneMission(first!.candidateId, 'A county published an RFP for parcel research, proposals due 25 September 2026.');
    expect(await harvest({ projectId })).toHaveLength(1);

    const methods = (await listSearchMethods(reader())).filter((m) => m.methodKey === first!.bucketId);
    expect(methods).toHaveLength(1);
    expect(methods[0]!.scope).toBe('PROJECT');
    expect(methods[0]!.projectId).toBe(projectId);
    const runs = await listMethodRuns(reader(), methods[0]!.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toBe('FOUND');
    expect(runs[0]!.executor).toBe('CLAUDE');
    expect(runs[0]!.surfaced).toBe(1);

    // A second harvest of the same closed round records no second run.
    await harvest({ projectId });
    expect(await listMethodRuns(reader(), methods[0]!.id)).toHaveLength(1);
  });

  it('says nothing about the method for a round stopped by a parked or cancelled mission', () => {
    expect(outcomeOfRound({ to: 'ABANDONED', missionState: 'NEEDS_HUMAN', found: 0, useful: 0, duplicates: 0 })).toBeNull();
    expect(outcomeOfRound({ to: 'ABANDONED', missionState: 'CANCELLED', found: 0, useful: 0, duplicates: 0 })).toBeNull();
    expect(outcomeOfRound({ to: 'ABANDONED', missionState: 'FAILED', found: 0, useful: 0, duplicates: 0 })?.outcome).toBe('ERROR');
    expect(outcomeOfRound({ to: 'HARVESTED', missionState: 'DONE', found: 0, useful: 0, duplicates: 0 })?.outcome).toBe('NOTHING_SUITABLE');
    expect(outcomeOfRound({ to: 'ABANDONED', missionState: 'NEEDS_HUMAN', found: 2, useful: 0, duplicates: 0 })?.outcome).toBe('FOUND');
  });
});

describe('a bucket that keeps failing is paused, not asked again', () => {
  it('openDiscovery skips a bucket whose recent rounds found nothing, and asks the others', async () => {
    const outcome = await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash.' });
    expect(outcome.ok).toBe(true);
    const failing = SEARCH_BUCKETS[0]!;
    for (let i = 0; i < FAILURE_STREAK; i += 1) {
      await recordRoundAsRun(projectId, failing, { to: 'HARVESTED', missionState: 'DONE', found: 0, useful: 0, duplicates: 0 });
    }
    const gate = (await bucketGates(projectId, [failing.id, SEARCH_BUCKETS[1]!.id], new Date().toISOString()));
    expect(gate.get(failing.id)?.mayOpen).toBe(false);
    expect(gate.get(failing.id)?.decision?.action).toBe('PAUSE');
    expect(gate.get(failing.id)?.decision?.cause).toBe('NO_SUITABLE_RESULTS');
    // A bucket with no method is development work, and may be asked.
    expect(gate.get(SEARCH_BUCKETS[1]!.id)).toMatchObject({ route: 'DEVELOP', mayOpen: true });

    const opened = await openDiscovery({ projectId, limit: SEARCH_BUCKETS.length + 50 });
    expect(opened.length).toBeGreaterThan(0);
    expect(opened.map((o) => o.bucketId)).not.toContain(failing.id);

    // Once its retry time has passed it may be tried once more.
    const later = new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString();
    expect((await bucketGates(projectId, [failing.id], later)).get(failing.id)?.mayOpen).toBe(true);
  });
});

describe('the search report terminal', () => {
  it('prints the live report and each method\'s decision from rows', async () => {
    const failing = SEARCH_BUCKETS[0]!;
    for (let i = 0; i < FAILURE_STREAK; i += 1) {
      await recordRoundAsRun(projectId, failing, { to: 'HARVESTED', missionState: 'DONE', found: 0, useful: 0, duplicates: 0 });
    }
    const report = await runSearchCli(['report', '--project', projectId]);
    expect(report.code).toBe(0);
    expect(report.out).toContain('SEARCH REPORT');
    expect(report.out).toContain(failing.id);
    expect(report.out).toMatch(/methods known 1/);

    const methods = await runSearchCli(['methods', '--project', projectId]);
    expect(methods.code).toBe(0);
    expect(methods.out).toContain(`${failing.id} PROPOSED PAUSE`);
    expect(methods.out).toContain('NO_SUITABLE_RESULTS');

    // Another project's reader sees none of it.
    const other = await runSearchCli(['methods', '--project', 'prj_nobody']);
    expect(other.out).toBe('no search methods recorded for this project yet');

    expect((await runSearchCli(['report'])).code).toBe(2);
  });

  it('compares methods only on shared data, and refuses otherwise', async () => {
    const files: Record<string, string> = { 'r.json': JSON.stringify({ items: ['a'], results: { m1: { surfaced: ['a'], confirmed: [], rejected: [] } } }) };
    const one = await runSearchCli(['compare', '--project', projectId, '--subject', 's', '--file', 'r.json'], { readFile: (p) => files[p]! });
    expect(one.code).toBe(1);
    expect(one.out).toContain('at least two methods');
  });

  it('records the comparison it prints, in the project it was asked for', async () => {
    const m1 = await createSearchMethod({ scope: 'GENERAL', methodKey: 'cli-1', subjectId: 's', finds: 'x', sources: ['s'], checkProcedure: 'c' });
    const m2 = await createSearchMethod({ scope: 'GENERAL', methodKey: 'cli-2', subjectId: 's', finds: 'x', sources: ['s'], checkProcedure: 'c' });
    const files: Record<string, string> = {
      'r.json': JSON.stringify({
        items: ['a', 'b'],
        results: { [m1.id]: { surfaced: ['a'], confirmed: ['a'], rejected: [] }, [m2.id]: { surfaced: ['a', 'b'], confirmed: ['a'], rejected: ['b'] } },
      }),
    };
    const out = await runSearchCli(['compare', '--project', projectId, '--subject', 's', '--file', 'r.json'], { readFile: (p) => files[p]! });
    expect(out.code).toBe(0);
    const stored = await listMethodComparisons({ projectIds: [projectId], userId: null }, { subjectId: 's' });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.scope).toBe('PROJECT');
    expect(stored[0]!.projectId).toBe(projectId);
    expect(stored[0]!.entries.map((e) => [e.methodId, e.rank, e.precision])).toEqual([[m1.id, 1, 1], [m2.id, 2, 0.5]]);
    expect(out.out).toContain(`comparison ${stored[0]!.id} recorded`);
  });
});
