/**
 * GOV-22-2, production acceptance: when a real objective later requires a
 * deferred capability, "the system identifies that dependency" — "No manual
 * owner instruction of the form 'now remember that old feature' is necessary."
 *
 * Pins that the Russell-tick entry (`advancePreparedOptions`) finds a goal's
 * blocked work from rows alone — an open cash need keyed CAPABILITY:<id> — matches
 * it to the recorded prepared option, hands the minimum permitted method to the
 * Factory without any caller naming the requirement, the goal or the blocked
 * work, and later judges resumption from that same blocked need.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { freshProject } from './helpers.ts';
import {
  PREPARED_HANDOFF_KIND,
  PREPARED_NEEDED_KIND,
  PREPARED_RESUMED_KIND,
  advancePreparedOptions,
  identifyDependencies,
  recordPreparedOption,
  type IdentifiedSubmission,
  type Submitter,
} from '../server/services/capability/prepared.ts';
import { listEvents } from '../server/repos/events.ts';
import { ensureCampaign, ensureChangeRequest, patchCampaign } from '../server/repos/factory.ts';
import { getDb } from '../server/db/database.ts';

const at = (iso: string, minutes: number): string => new Date(Date.parse(iso) + minutes * 60_000).toISOString();

const option = (requirementId: string, gates: string[] = []) => ({
  requirementId,
  feasibility: { verdict: 'FEASIBLE', note: 'a public tool exists' },
  methods: [
    { name: 'browser-bot', kind: 'NO_API', gates: [], effort: 5, sources: ['https://example.test/b'] },
    { name: 'cli-tool', kind: 'OPEN_SOURCE_TOOL', gates, effort: 2, sources: ['https://example.test/a'] },
  ],
  sourceInventory: ['https://example.test/a'],
});

describe('a goal\'s dependency on a prepared option is identified from rows', () => {
  let projectId: string;
  let submitted: IdentifiedSubmission[];
  let submit: Submitter;
  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
    submitted = [];
    submit = async (s) => {
      submitted.push(s);
      const { changeRequest, created } = await ensureChangeRequest({
        projectId: s.projectId, submissionKey: s.submissionKey, objective: s.objective, expectedOutcome: s.expectedOutcome,
        nonGoals: [], acceptanceConditions: s.acceptanceConditions.map((c, i) => ({ id: `A0${i + 1}`, ...c })),
        repository: 'o/r', repositoryRoot: null, baseBranch: 'production', baseSha: 'a'.repeat(40), environment: 'LOCAL',
        riskClass: 'MEDIUM', mutationScope: ['server/**'], deploymentPolicy: 'NONE', rollbackRequirement: 'revert',
        verificationCommands: ['npm run typecheck'],
      });
      return { changeRequestId: changeRequest.id, created };
    };
  });

  const blockedNeed = async (key: string, state: 'OPEN' | 'RESOLVED' = 'OPEN'): Promise<string> => {
    const id = `need_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const now = new Date().toISOString();
    await getDb().run(
      `INSERT INTO cash_needs (id, project_id, opportunity_id, blocked_action, why_it_matters, recommended_path, setup_effort, next_step, state, blocker_key, created_at, updated_at)
       VALUES (?, ?, NULL, 'send the offer', 'the goal cannot sell without it', 'add the capability', 'small', 'build it', ?, ?, ?, ?)`,
      [id, projectId, state, key, now, now],
    );
    return id;
  };
  const kinds = async (kind: string) => (await listEvents(projectId, 200)).filter((e) => e.payload.kind === kind);

  it('finds nothing when no goal is blocked on the option, and hands nothing off', async () => {
    await recordPreparedOption(projectId, option('SEND_BY_FAX'));
    await blockedNeed('CAPABILITY:SOMETHING_ELSE');
    await blockedNeed('CAPABILITY:SEND_BY_FAX', 'RESOLVED');
    expect(await identifyDependencies(projectId)).toEqual([]);
    await advancePreparedOptions({ submit });
    expect(submitted).toHaveLength(0);
    expect(await kinds(PREPARED_HANDOFF_KIND)).toHaveLength(0);
  });

  it('identifies the blocked need, compares methods and hands the cheapest permitted one to the Factory, once, with no caller naming anything', async () => {
    await recordPreparedOption(projectId, option('SEND_BY_FAX'));
    const need = await blockedNeed('CAPABILITY:SEND_BY_FAX');
    const found = await identifyDependencies(projectId);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ requirementId: 'SEND_BY_FAX', blockedNeedIds: [need] });

    const first = await advancePreparedOptions({ submit });
    expect(first).toMatchObject({ identified: 1, handedOff: 1 });
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.objective).toMatch(/cli-tool/);
    const handoffs = await kinds(PREPARED_HANDOFF_KIND);
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]!.payload).toMatchObject({ blockedNeedIds: [need], identified: true, method: 'cli-tool', integration: false });
    expect(await kinds(PREPARED_NEEDED_KIND)).toHaveLength(1);

    // A second pass does not hand the same dependency off again.
    const second = await advancePreparedOptions({ submit });
    expect(second.handedOff).toBe(0);
    expect(submitted).toHaveLength(1);
    expect(await kinds(PREPARED_HANDOFF_KIND)).toHaveLength(1);
  });

  it('records a dependency whose every method is gated, with the gates, and hands nothing off', async () => {
    await recordPreparedOption(projectId, {
      ...option('SEND_BY_FAX', ['CREDENTIALS']),
      methods: [{ name: 'cli-tool', kind: 'OPEN_SOURCE_TOOL', gates: ['CREDENTIALS'], effort: 2, sources: [] }],
    });
    await blockedNeed('CAPABILITY:SEND_BY_FAX');
    expect(await advancePreparedOptions({ submit })).toMatchObject({ identified: 1, handedOff: 0 });
    expect(submitted).toHaveLength(0);
    const needed = await kinds(PREPARED_NEEDED_KIND);
    expect(needed).toHaveLength(1);
    expect(needed[0]!.payload).toMatchObject({ minimum: null, needsPerson: ['CREDENTIALS'] });
  });

  it('a refused submission is retried on the next pass rather than lost', async () => {
    await recordPreparedOption(projectId, option('SEND_BY_FAX'));
    await blockedNeed('CAPABILITY:SEND_BY_FAX');
    const refuse: Submitter = async () => { throw new Error('forge unreachable'); };
    expect(await advancePreparedOptions({ submit: refuse })).toMatchObject({ handedOff: 0 });
    expect(await kinds(PREPARED_HANDOFF_KIND)).toHaveLength(0);
    expect(await advancePreparedOptions({ submit })).toMatchObject({ handedOff: 1 });
  });

  it('judges resumption from the identified blocked need: resolved by Brain after the campaign completed', async () => {
    await recordPreparedOption(projectId, option('SEND_BY_FAX'));
    const need = await blockedNeed('CAPABILITY:SEND_BY_FAX');
    await advancePreparedOptions({ submit });
    const handoff = (await kinds(PREPARED_HANDOFF_KIND))[0]!;
    const cr = handoff.payload.changeRequestId as string;
    const t0 = handoff.createdAt;

    // Resolved before the change was implemented: not caused by it.
    await getDb().run(`UPDATE cash_needs SET state = 'RESOLVED', resolved_at = ?, verified_by = 'BRAIN_READ_THE_ROW' WHERE id = ?`, [at(t0, 1), need]);
    const { campaign } = await ensureCampaign({ changeRequestId: cr, projectId, baseSha: 'a'.repeat(40), laneTarget: 1, laneTargetReason: 'test' });
    await patchCampaign(campaign.id, { state: 'COMPLETE', finishedAt: at(t0, 2) });
    expect(await advancePreparedOptions({ submit })).toMatchObject({ resumed: 0 });

    // A person's manual substitute is not the capability working.
    await getDb().run(`UPDATE cash_needs SET resolved_at = ?, verified_by = 'PERSON_SUBSTITUTE' WHERE id = ?`, [at(t0, 3), need]);
    expect(await advancePreparedOptions({ submit })).toMatchObject({ resumed: 0 });

    await getDb().run(`UPDATE cash_needs SET resolved_at = ?, verified_by = 'BRAIN_READ_THE_ROW' WHERE id = ?`, [at(t0, 3), need]);
    expect(await advancePreparedOptions({ submit })).toMatchObject({ resumed: 1 });
    const resumed = await kinds(PREPARED_RESUMED_KIND);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.payload).toMatchObject({ changeRequestId: cr, completedAfter: [need] });
  });
});
