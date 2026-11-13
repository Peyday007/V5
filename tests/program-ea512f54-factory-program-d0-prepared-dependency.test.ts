/**
 * GOV-22-2, finding F2: when a real objective later requires a deferred
 * capability, the system identifies that dependency itself.
 *
 * Nothing here calls `resolveNeed` or `handOffToFactory` with a requirement, a
 * goal or blocked work items: the only inputs are rows — a recorded prepared
 * option, and open work (a bin, an open need) that names its requirement. The
 * tick (`advancePreparedOptions`) finds the dependency, compares the access
 * methods, hands the minimum to the existing Factory entrance, and later judges
 * resumption from the blocked items it found.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const submitted: Array<Record<string, unknown>> = [];
let repositories: Array<{ remote: string }> = [];

vi.mock('../server/services/russell/software.ts', () => ({
  repositoryChoicesFor: async () => repositories,
}));
vi.mock('../server/services/factory/contract.ts', async () => {
  const { ensureChangeRequest } = await import('../server/repos/factory.ts');
  class ContractError extends Error {}
  return {
    ContractError,
    submitObjective: async (s: Record<string, unknown>) => {
      submitted.push(s);
      const out = await ensureChangeRequest({
        projectId: s.projectId as string,
        submissionKey: s.submissionKey as string,
        objective: s.objective as string,
        expectedOutcome: s.expectedOutcome as string,
        nonGoals: s.nonGoals as string[],
        acceptanceConditions: (s.acceptanceConditions as Array<{ statement: string; verification: string }>).map((c, i) => ({
          id: `A0${i + 1}`, statement: c.statement, verification: c.verification, mandatory: true,
        })),
        repository: s.repositoryRemote as string,
        repositoryRoot: null,
        baseBranch: 'main',
        baseSha: 'b'.repeat(40),
        environment: 'LOCAL',
        riskClass: 'MEDIUM',
        mutationScope: ['server/**'],
        deploymentPolicy: 'NONE',
        rollbackRequirement: 'revert',
        verificationCommands: ['npm run typecheck'],
      });
      return { ...out, derived: {} };
    },
  };
});

import { freshProject } from './helpers.ts';
import {
  PREPARED_DEPENDENCY_KIND,
  PREPARED_HANDOFF_KIND,
  PREPARED_RESUMED_KIND,
  advancePreparedOptions,
  identifyDependencies,
  recordPreparedOption,
} from '../server/services/capability/prepared.ts';
import { listEvents } from '../server/repos/events.ts';
import { createBin } from '../server/repos/bins.ts';
import { ensureCampaign, patchCampaign } from '../server/repos/factory.ts';
import { enqueueWork } from '../server/repos/workQueue.ts';
import { getDb } from '../server/db/database.ts';
import type { BinManifest } from '../server/domain/types.ts';

let projectId: string;

const option = (requirementId: string, methods: unknown[]) => recordPreparedOption(projectId, {
  requirementId,
  feasibility: { verdict: 'FEASIBLE', note: 'a public tool exists' },
  methods,
  sourceInventory: ['https://example.test/a'],
});
const tool = (over: Record<string, unknown> = {}) => ({ name: 'tool-a', kind: 'OPEN_SOURCE_TOOL', gates: [], effort: 2, sources: [], ...over });

const manifest = (goal: string | null): BinManifest => ({
  objective: 'Do the declared thing.',
  why: 'a dependency test',
  lineage: { projectId, layerId: null, goal, orchestrationId: null },
  units: [{ key: 'u', establishes: 'a value', input: '{}', transform: 'sha256', dependsOn: [] }],
  acceptableSources: [],
  excludedSources: [],
  evidence: ['a stored value'],
  outputs: ['one result'],
  authorizedActions: ['submit unit results'],
  prohibitedActions: ['anything with an external effect'],
  budgetUnits: 1,
  retry: { maxAttempts: 3, backoffSeconds: 30 },
  stoppingConditions: ['the declared unit has a result'],
} as BinManifest);

/** Open work of a real objective that cannot run without `capability`. */
const blockedBin = async (capabilities: string[], goal: string | null = 'goal-x'): Promise<{ binId: string; itemId: string }> => {
  const bin = await createBin({
    projectId,
    kind: 'RESEARCH_PACKET',
    title: 'Blocked research',
    objective: 'Establish something that needs the capability.',
    manifest: manifest(goal),
    completionContract: 'DETERMINISTIC_UNITS_V1',
    workloadClass: 'RESEARCH',
    requiredCapabilities: capabilities,
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
  });
  const item = await enqueueWork({ projectId, workType: 'RESEARCH_AUDIT', payload: { role: 'PRIMARY' }, createdByType: 'SYSTEM', binId: bin.id });
  return { binId: bin.id, itemId: item.id };
};

const kinds = async (kind: string) => (await listEvents(projectId, 200)).filter((e) => e.payload.kind === kind);

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  submitted.length = 0;
  repositories = [];
});

describe('a prepared option is matched to the work that needs it, from rows alone', () => {
  it('finds an open bin naming the requirement, with its unfinished items, and ignores the rest', async () => {
    await option('CAP.SCRAPE', [tool()]);
    const blocked = await blockedBin(['CAP.SCRAPE', 'repository']);
    await blockedBin(['SOMETHING.ELSE']);
    const done = await blockedBin(['CAP.SCRAPE']);
    await getDb().run(`UPDATE bins SET state = 'COMPLETE' WHERE id = ?`, [done.binId]);

    const deps = await identifyDependencies(projectId, ['CAP.SCRAPE']);
    expect(deps).toEqual([
      { projectId, requirementId: 'CAP.SCRAPE', sourceRef: `bin:${blocked.binId}`, goal: 'goal-x', blockedWorkItemIds: [blocked.itemId] },
    ]);
  });

  it('a requirement id that is a prefix of another is not a match', async () => {
    await blockedBin(['CAP.SCRAPE.V2']);
    expect(await identifyDependencies(projectId, ['CAP.SCRAPE'])).toEqual([]);
  });

  it('with no repository onboarded the dependency is recorded once, with the comparison, and nothing is forced', async () => {
    await option('CAP.SCRAPE', [tool({ name: 'cheap', effort: 1 }), tool({ name: 'paid-api', kind: 'API', gates: ['SPEND'], effort: 1 })]);
    const blocked = await blockedBin(['CAP.SCRAPE']);

    expect(await advancePreparedOptions()).toMatchObject({ identified: 1, handedOff: 0 });
    expect(await advancePreparedOptions()).toMatchObject({ identified: 0, handedOff: 0 });

    const deps = await kinds(PREPARED_DEPENDENCY_KIND);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.payload).toMatchObject({
      integration: false, sourceRef: `bin:${blocked.binId}`, goal: 'goal-x', blockedWorkItemIds: [blocked.itemId],
      permitted: ['cheap'], gated: [{ method: 'paid-api', gates: ['SPEND'] }], minimum: 'cheap', needsPerson: ['SPEND'],
    });
    expect(submitted).toHaveLength(0);
    expect(await kinds(PREPARED_HANDOFF_KIND)).toHaveLength(0);
  });

  it('only gated methods: identified, never handed off, the gate named for a person', async () => {
    repositories = [{ remote: 'https://github.com/o/r' }];
    await option('CAP.SCRAPE', [tool({ gates: ['CREDENTIALS'] })]);
    await blockedBin(['CAP.SCRAPE']);
    expect(await advancePreparedOptions()).toMatchObject({ identified: 1, handedOff: 0 });
    expect((await kinds(PREPARED_DEPENDENCY_KIND))[0]!.payload).toMatchObject({ minimum: null, needsPerson: ['CREDENTIALS'] });
    expect(submitted).toHaveLength(0);
  });

  it('hands the minimum to the existing Factory once, then judges resumption of the items it found', async () => {
    repositories = [{ remote: 'https://github.com/o/r' }];
    await option('CAP.SCRAPE', [tool({ name: 'slow', effort: 3 }), tool({ name: 'fast', effort: 1 })]);
    const blocked = await blockedBin(['CAP.SCRAPE']);

    expect(await advancePreparedOptions()).toMatchObject({ identified: 1, handedOff: 1, resumed: 0 });
    expect(await advancePreparedOptions()).toMatchObject({ identified: 0, handedOff: 0, resumed: 0 });
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({ projectId, repositoryRemote: 'https://github.com/o/r' });
    expect(String(submitted[0]!.objective)).toContain('"CAP.SCRAPE"');
    expect(String(submitted[0]!.objective)).toContain('fast');

    const handoffs = await kinds(PREPARED_HANDOFF_KIND);
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]!.payload).toMatchObject({ goal: 'goal-x', method: 'fast', blockedWorkItemIds: [blocked.itemId], identifiedFrom: `bin:${blocked.binId}` });
    const changeRequestId = handoffs[0]!.payload.changeRequestId as string;
    const handedOffAt = handoffs[0]!.createdAt;
    const later = (h: number) => new Date(Date.parse(handedOffAt) + h * 3_600_000).toISOString();

    // The Factory implements it; the blocked work then runs. Nobody names either to the tick.
    const { campaign } = await ensureCampaign({ changeRequestId, projectId, baseSha: 'b'.repeat(40), laneTarget: 1, laneTargetReason: 'test' });
    await patchCampaign(campaign.id, { state: 'COMPLETE', finishedAt: later(1) });
    await getDb().run(`UPDATE work_items SET state = 'SUCCEEDED', completed_at = ? WHERE id = ?`, [later(2), blocked.itemId]);

    expect(await advancePreparedOptions()).toMatchObject({ resumed: 1 });
    const resumed = await kinds(PREPARED_RESUMED_KIND);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.payload).toMatchObject({ changeRequestId, completedAfter: [blocked.itemId] });
  });

  it('an open need for the capability is a dependency too', async () => {
    await option('CAP.SCRAPE', [tool()]);
    const { raiseNeed } = await import('../server/services/cash/needs.ts');
    await raiseNeed({
      projectId, actorRef: 'test', blockedAction: 'Progress "an opening"', whyItMatters: 'it needs scraping',
      recommendedPath: 'build it', setupEffort: 'small', nextStep: 'build', completionCondition: 'it reads present',
      requestKey: 'capability:opp_1:CAP.SCRAPE',
    });
    await raiseNeed({
      projectId, actorRef: 'test', blockedAction: 'Progress "another opening"', whyItMatters: 'it needs scraping',
      recommendedPath: 'build it', setupEffort: 'small', nextStep: 'build', completionCondition: 'it reads present',
      requestKey: 'other-key', blockerKey: 'CAPABILITY:CAP.SCRAPE',
    });
    const deps = await identifyDependencies(projectId, ['CAP.SCRAPE']);
    expect(deps).toHaveLength(2);
    for (const dep of deps) {
      expect(dep).toMatchObject({ requirementId: 'CAP.SCRAPE', blockedWorkItemIds: [] });
      expect(dep.sourceRef).toMatch(/^need:/);
    }
  });
});
