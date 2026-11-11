/**
 * GOV-22-2, production acceptance: when a real objective later requires a
 * deferred capability, "the system identifies that dependency" — and "no manual
 * owner instruction of the form 'now remember that old feature' is necessary".
 *
 * Nothing here calls `resolveNeed` or `handOffToFactory` with a requirement, a
 * goal or blocked work items: the only inputs are a recorded prepared option and
 * a waiting bin that declares the requirement in `required_capabilities`. The
 * tick (`advancePreparedOptions`) must find the dependency, hand the minimum to
 * the Factory once, and judge resumption from the bin's own row.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createBin } from '../server/repos/bins.ts';
import { getDb } from '../server/db/database.ts';
import { listEventsByEntity } from '../server/repos/events.ts';
import {
  PREPARED_HANDOFF_KIND,
  PREPARED_NEED_KIND,
  PREPARED_RESUMED_KIND,
  advancePreparedOptions,
  identifyNeeds,
  needGoal,
  preparedSubmissionKey,
  recordPreparedOption,
  type PreparedNeedDeps,
} from '../server/services/capability/prepared.ts';
import type { BinManifest } from '../server/domain/types.ts';

const REQ = `req-needs-${Math.random().toString(36).slice(2, 8)}`;

const option = (methods: unknown[]) => ({
  requirementId: REQ,
  feasibility: { verdict: 'FEASIBLE', note: 'an open-source tool reads it' },
  methods,
  sourceInventory: ['https://example.test/tool'],
});
const cheap = { name: 'open-tool', kind: 'OPEN_SOURCE_TOOL', gates: [], effort: 1, sources: ['https://example.test/tool'] };
const gated = { name: 'paid-api', kind: 'API', gates: ['CREDENTIALS', 'SPEND'], effort: 1, sources: ['https://example.test/api'] };

const MANIFEST = (projectId: string): BinManifest =>
  ({
    objective: 'goal work',
    why: 'a goal needs it',
    lineage: { projectId, layerId: null, goal: null, orchestrationId: null },
    units: [],
    acceptableSources: [],
    excludedSources: [],
    evidence: [],
    outputs: [],
    authorizedActions: [],
    prohibitedActions: [],
    budgetUnits: null,
    retry: { maxAttempts: 2, backoffSeconds: 30 },
    stoppingConditions: [],
  }) as unknown as BinManifest;

async function waitingBin(projectId: string, requiredCapabilities: string[]): Promise<string> {
  return (
    await createBin({
      projectId,
      kind: 'DETERMINISTIC_CHECK',
      title: 'goal work needing a deferred capability',
      objective: 'goal work',
      manifest: MANIFEST(projectId),
      completionContract: 'DETERMINISTIC_UNITS_V1',
      createdByType: 'SYSTEM',
      createdById: 'test',
      ready: true,
      requiredCapabilities,
    })
  ).id;
}

function fakeFactory(repositories = 1) {
  const submitted: Array<Parameters<NonNullable<PreparedNeedDeps['submit']>>[0]> = [];
  const deps: PreparedNeedDeps = {
    repositoryChoices: async () =>
      Array.from({ length: repositories }, (_, i) => ({ remote: `https://example.test/o/r${i}`, repositoryId: `o/r${i}` })),
    submit: async (input) => {
      submitted.push(input);
      return { changeRequest: { id: `fcr_${input.submissionKey}` }, created: submitted.length === 1 };
    },
  };
  return { deps, submitted };
}

const kinds = async (projectId: string) =>
  (await listEventsByEntity('capability_requirement', REQ)).filter((e) => e.projectId === projectId);

describe('a waiting goal is matched to a prepared option without anyone remembering it', () => {
  let projectId: string;
  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
  });

  it('identifies the dependency from the bin row alone', async () => {
    await recordPreparedOption(projectId, option([cheap]));
    const binId = await waitingBin(projectId, ['SOMETHING_ELSE', REQ]);
    await waitingBin(projectId, ['UNRELATED']);
    const needs = (await identifyNeeds()).filter((n) => n.projectId === projectId);
    expect(needs).toHaveLength(1);
    expect(needs[0]).toMatchObject({ requirementId: REQ, goal: needGoal(projectId, REQ), blockedBinIds: [binId] });
  });

  it('identifies nothing when no prepared option stands behind the requirement', async () => {
    await waitingBin(projectId, [REQ]);
    expect((await identifyNeeds()).filter((n) => n.projectId === projectId)).toEqual([]);
  });

  it('the tick hands the minimum to the Factory once and judges resumption from the bin', async () => {
    await recordPreparedOption(projectId, option([gated, cheap]));
    const binId = await waitingBin(projectId, [REQ]);
    const { deps, submitted } = fakeFactory();

    await advancePreparedOptions(deps);
    await advancePreparedOptions(deps);

    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.objective).toContain(REQ);
    expect(submitted[0]!.objective).toContain('open-tool');
    expect(submitted[0]!.objective).not.toContain('paid-api');
    expect(submitted[0]!.submissionKey).toBe(preparedSubmissionKey(projectId, REQ, needGoal(projectId, REQ)));

    let events = await kinds(projectId);
    const need = events.filter((e) => e.payload.kind === PREPARED_NEED_KIND);
    expect(need).toHaveLength(1);
    expect(need[0]!.payload).toMatchObject({ outcome: 'HANDED_OFF', identifiedBy: 'BRAIN', minimum: 'open-tool', integration: false });
    expect(need[0]!.payload.needsPerson).toEqual(['CREDENTIALS', 'SPEND']);
    const handoff = events.filter((e) => e.payload.kind === PREPARED_HANDOFF_KIND);
    expect(handoff).toHaveLength(1);
    expect(handoff[0]!.payload).toMatchObject({ blockedBinIds: [binId], integration: false });
    expect(events.some((e) => e.payload.kind === PREPARED_RESUMED_KIND)).toBe(false);

    // The goal's blocked work runs after the handoff.
    const later = new Date(Date.now() + 60_000).toISOString();
    await getDb().run(`UPDATE bins SET state = 'COMPLETE', completed_at = ?, updated_at = ? WHERE id = ?`, [later, later, binId]);
    await advancePreparedOptions(deps);
    await advancePreparedOptions(deps);
    events = await kinds(projectId);
    const resumed = events.filter((e) => e.payload.kind === PREPARED_RESUMED_KIND);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.payload.completedAfter).toEqual([binId]);
  });

  it('only gated methods: the need is recorded for a person, nothing is handed over, no gate crossed', async () => {
    await recordPreparedOption(projectId, option([gated]));
    await waitingBin(projectId, [REQ]);
    const { deps, submitted } = fakeFactory();
    await advancePreparedOptions(deps);
    await advancePreparedOptions(deps);
    expect(submitted).toHaveLength(0);
    const events = await kinds(projectId);
    const need = events.filter((e) => e.payload.kind === PREPARED_NEED_KIND);
    expect(need).toHaveLength(1);
    expect(need[0]!.payload.outcome).toBe('GATED');
    expect(events.some((e) => e.payload.kind === PREPARED_HANDOFF_KIND)).toBe(false);
  });

  it('no onboarded repository: recorded once, then handed off once one exists', async () => {
    await recordPreparedOption(projectId, option([cheap]));
    await waitingBin(projectId, [REQ]);
    const none = fakeFactory(0);
    await advancePreparedOptions(none.deps);
    await advancePreparedOptions(none.deps);
    expect(none.submitted).toHaveLength(0);
    let events = await kinds(projectId);
    expect(events.filter((e) => e.payload.kind === PREPARED_NEED_KIND).map((e) => e.payload.outcome)).toEqual(['NO_REPOSITORY']);

    const one = fakeFactory(1);
    await advancePreparedOptions(one.deps);
    expect(one.submitted).toHaveLength(1);
    events = await kinds(projectId);
    expect(events.filter((e) => e.payload.kind === PREPARED_HANDOFF_KIND)).toHaveLength(1);
  });

  it('a Factory refusal is recorded and never mistaken for a handoff', async () => {
    await recordPreparedOption(projectId, option([cheap]));
    await waitingBin(projectId, [REQ]);
    const deps: PreparedNeedDeps = {
      repositoryChoices: async () => [{ remote: 'https://example.test/o/r', repositoryId: 'o/r' }],
      submit: async () => { throw new Error('the forge did not answer'); },
    };
    await advancePreparedOptions(deps);
    const events = await kinds(projectId);
    expect(events.find((e) => e.payload.kind === PREPARED_NEED_KIND)?.payload).toMatchObject({ outcome: 'FACTORY_REFUSED', reason: 'the forge did not answer' });
    expect(events.some((e) => e.payload.kind === PREPARED_HANDOFF_KIND)).toBe(false);
  });
});
