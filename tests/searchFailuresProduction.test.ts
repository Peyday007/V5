/**
 * The two failure causes production could not reach (repair F3-2).
 *
 * `classifyFailure` names SOURCE_UNAVAILABLE and HIGH_FALSE_POSITIVES, but the
 * only production writers of method runs — a feeds pass (`recordLearnedPass`,
 * via `runDetectors`) and a closed discovery round (`recordRoundAsRun`, via
 * `harvest`) — recorded FOUND, NOTHING_SUITABLE or ERROR, so those two causes
 * could only come from runs a test wrote. These drive the production entry
 * points — `pullDueFeeds`, `runDetectors`, `harvest` — and read the runs and
 * the decision they leave.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Layer } from '../server/domain/types.ts';
import { freshProject } from './helpers.ts';
import { insertFeedItems } from '../server/repos/feeds.ts';
import { createUser } from '../server/repos/identity.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration, currentFragments, updateFragment } from '../server/repos/research.ts';
import { launchMission, linkMission, transitionMission } from '../server/repos/russellMissions.ts';
import { createSearchMethod, listMethodRuns, listSearchMethods, recordDetectorExample } from '../server/repos/searchMethods.ts';
import { createDetectorFromExamples } from '../server/services/feeds/learned.ts';
import { runDetectors } from '../server/services/feeds/detectors.ts';
import { pullDueFeeds } from '../server/services/feeds/run.ts';
import type { FeedSource } from '../server/services/feeds/sources.ts';
import { FEED_READER } from '../server/services/feeds/learnedRun.ts';
import { decideMethod, FAILURE_STREAK } from '../server/services/research/searchFailures/classify.ts';
import { outcomeOfRound } from '../server/services/research/searchMethods/bucketMethods.ts';
import { SIGNAL_LANE, harvest, openDiscovery } from '../server/services/cash/discovery.ts';
import { activate } from '../server/services/cash/lifecycle.ts';

const positives = ['Senior welding fabricator needed', 'Welding fabricator for trailers', 'Fabricator welding certified role'];
let n = 0;
const item = (title: string) => {
  n += 1;
  return { externalId: `p${n}`, url: `https://x.test/p${n}`, title, body: null, organization: null, publishedAt: null };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function methodWithDetector(key: string, source: string) {
  const method = await createSearchMethod({
    scope: 'GENERAL', methodKey: key, finds: 'employers hiring welders', sources: [source],
    checkProcedure: 'the title names welding fabrication',
  });
  const made = await createDetectorFromExamples({
    scope: 'GENERAL', methodId: method.id, detectorKey: `${key}-det`, sources: [source], positives, negatives: [], threshold: 0.8,
  });
  if (!made.ok) throw new Error('setup');
  return { method, detector: made.detector };
}

const brokenSource = (id: string): FeedSource => ({
  id, label: id, url: `https://unreachable.test/${id}`, intervalMs: 0, parse: () => [],
});
const refused = async () => { throw new Error('fetch failed (ENOTFOUND)'); };

describe('a feeds pass records a source it could not read as SOURCE_UNAVAILABLE', () => {
  beforeEach(async () => { await freshProject(); });

  it('records SOURCE_UNAVAILABLE when every pull of the detector\'s sources failed, and pauses the method for that cause', async () => {
    const { method } = await methodWithDetector('src-down', 'down-feed');
    for (let i = 0; i < FAILURE_STREAK; i += 1) {
      await tick();
      const pulled = await pullDueFeeds({ sources: [brokenSource('down-feed')], fetcher: refused, now: new Date(Date.now() + i * 86_400_000) });
      expect(pulled[0]?.error).toMatch(/ENOTFOUND/);
      await tick();
      await runDetectors();
    }
    const runs = await listMethodRuns(FEED_READER, method.id);
    expect(runs.map((r) => r.outcome)).toEqual(Array(FAILURE_STREAK).fill('SOURCE_UNAVAILABLE'));
    expect(runs[0]!.failureCause).toMatch(/down-feed/);
    const decision = decideMethod(runs, new Date().toISOString());
    expect(decision.cause).toBe('SOURCE_UNAVAILABLE');
    expect(decision.action).toBe('PAUSE');
  });

  it('records nothing for a pass with nothing new when no pull failed, and nothing twice for one failed pull', async () => {
    const { method } = await methodWithDetector('src-quiet', 'quiet-feed');
    await runDetectors();
    expect(await listMethodRuns(FEED_READER, method.id)).toHaveLength(0);
    await pullDueFeeds({ sources: [brokenSource('quiet-feed')], fetcher: refused });
    await tick();
    await runDetectors();
    await runDetectors();
    expect((await listMethodRuns(FEED_READER, method.id)).map((r) => r.outcome)).toEqual(['SOURCE_UNAVAILABLE']);
  });
});

describe('a feeds pass records mostly-wrong surfacings as FALSE_POSITIVES', () => {
  beforeEach(async () => { await freshProject(); });

  it('records FALSE_POSITIVES once the detector\'s judged firings are mostly rejected, and asks for revision', async () => {
    const { method, detector } = await methodWithDetector('fp', 'jobs-fp');
    const ids = await insertFeedItems('jobs-fp', [item('Welding fabricator wanted')]);
    expect(ids).toBe(1);
    // People judged five firings: four were wrong.
    for (let i = 0; i < 5; i += 1) {
      await recordDetectorExample({ detectorId: detector.id, itemRef: `judged-${i}`, fired: true, verdict: i === 0 ? 'CONFIRMED' : 'REJECTED', labelledBy: 'test' });
    }
    await runDetectors();
    for (let i = 1; i < FAILURE_STREAK; i += 1) {
      await tick();
      await insertFeedItems('jobs-fp', [item(`Welding fabricator role ${i}`)]);
      await runDetectors();
    }
    const runs = await listMethodRuns(FEED_READER, method.id);
    expect(runs.map((r) => r.outcome)).toEqual(Array(FAILURE_STREAK).fill('FALSE_POSITIVES'));
    expect(runs[0]!.surfaced).toBe(1);
    const decision = decideMethod(runs, new Date().toISOString());
    expect(decision.cause).toBe('HIGH_FALSE_POSITIVES');
    expect(decision.action).toBe('REVISE');
  });

  it('still records FOUND while the judged firings are mostly right', async () => {
    const { method, detector } = await methodWithDetector('fp-ok', 'jobs-ok');
    for (let i = 0; i < 5; i += 1) {
      await recordDetectorExample({ detectorId: detector.id, itemRef: `ok-${i}`, fired: true, verdict: i === 0 ? 'REJECTED' : 'CONFIRMED', labelledBy: 'test' });
    }
    await insertFeedItems('jobs-ok', [item('Welding fabricator wanted')]);
    await runDetectors();
    expect((await listMethodRuns(FEED_READER, method.id)).map((r) => r.outcome)).toEqual(['FOUND']);
  });
});

describe('a closed discovery round names an unreadable source and mostly-duplicate filings', () => {
  it('classifies a round from its counts', () => {
    const base = { useful: 0, duplicates: 0 };
    expect(outcomeOfRound({ ...base, to: 'HARVESTED', missionState: 'DONE', found: 0, fragments: 2, sourceBlocked: 1 })?.outcome).toBe('SOURCE_UNAVAILABLE');
    expect(outcomeOfRound({ ...base, to: 'ABANDONED', missionState: 'FAILED', found: 0, fragments: 1, sourceBlocked: 1 })?.outcome).toBe('SOURCE_UNAVAILABLE');
    expect(outcomeOfRound({ ...base, to: 'HARVESTED', missionState: 'DONE', found: 0, fragments: 3, sourceBlocked: 1 })?.outcome).toBe('NOTHING_SUITABLE');
    // A parked mission is still not evidence, whatever its fragments say.
    expect(outcomeOfRound({ ...base, to: 'ABANDONED', missionState: 'NEEDS_HUMAN', found: 0, fragments: 1, sourceBlocked: 1 })).toBeNull();
    expect(outcomeOfRound({ to: 'HARVESTED', missionState: 'DONE', found: 3, useful: 0, duplicates: 2 })?.outcome).toBe('FALSE_POSITIVES');
    expect(outcomeOfRound({ to: 'HARVESTED', missionState: 'DONE', found: 4, useful: 1, duplicates: 2 })?.outcome).toBe('FOUND');
  });

  it('harvest records SOURCE_UNAVAILABLE for a round whose research was blocked on unreadable sources', async () => {
    const fixture = await freshProject();
    const projectId = fixture.project.id;
    const layer: Layer = await fixture.layerByName('Discovery Logic');
    const user = await createUser({
      email: `f3-2-${Math.random().toString(36).slice(2, 10)}@example.test`,
      displayName: 'Owner', password: 'correct horse battery staple',
    });
    expect((await activate({ projectId, ownerUserId: user.id, actorUserId: user.id, objective: 'Maximize additional usable cash.' })).ok).toBe(true);
    const [first] = await openDiscovery({ projectId });

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
    await updateFragment(fragment!.id, {
      status: 'BLOCKED', blockCause: 'SOURCE_ACCESS',
      blockedReason: 'CONNECT tunnel failed, response 403 from the egress proxy',
    });
    const { mission } = await launchMission({ projectId, layerId: layer.id, visibility: 'SHARED', objective: 'a bucket', whyNow: 'active', idempotencyKey: `mission:${o.id}`, candidateId: first!.candidateId });
    await linkMission({ missionId: mission.id, orchestrationId: o.id });
    await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
    await transitionMission({ missionId: mission.id, from: 'RUNNING', to: 'FAILED', terminalReason: 'research blocked', waitingOn: null });

    // Nothing was filed; the round still closes, and its run is recorded.
    expect(await harvest({ projectId })).toHaveLength(0);
    const reader = { projectIds: [projectId], userId: null };
    const method = (await listSearchMethods(reader)).find((m) => m.methodKey === first!.bucketId);
    expect(method).toBeTruthy();
    const runs = await listMethodRuns(reader, method!.id);
    expect(runs.map((r) => r.outcome)).toEqual(['SOURCE_UNAVAILABLE']);
    expect(runs[0]!.failureCause).toMatch(/could not be read/);
  });
});

