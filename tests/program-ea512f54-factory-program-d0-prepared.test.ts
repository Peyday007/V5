/**
 * GOV-22-2: a prepared option is cheap and is not a production integration.
 *
 * Pins what `server/services/capability/prepared.ts` refuses (validation), how a
 * real need classifies each access method by the gates still closed
 * (`resolveNeed`), and that nothing recorded here ever reads as an integration.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import {
  COSTLY_EFFORT,
  PREPARED_OPTION_KIND,
  PREPARED_RESUMED_KIND,
  PreparedOptionError,
  advancePreparedOptions,
  countsAsIntegration,
  handOffToFactory,
  handoffCausedResumption,
  resumeOf,
  preparedOptions,
  recordPreparedOption,
  resolveNeed,
  optionFromRequirement,
  PREPARED_HANDOFF_KIND,
  PREPARED_NEED_KIND,
  type FactorySubmit,
  type PreparedFactoryAsk,
  validatePreparedOption,
  warmCost,
  type PreparedOption,
} from '../server/services/capability/prepared.ts';
import { listEvents } from '../server/repos/events.ts';
import { ensureCampaign, ensureChangeRequest, patchCampaign } from '../server/repos/factory.ts';
import { enqueueWork } from '../server/repos/workQueue.ts';
import { getDb } from '../server/db/database.ts';
import { recordEvent } from '../server/repos/events.ts';
import { CAPABILITY_MAPS } from '../server/domain/capabilityMap.ts';

const method = (over: Record<string, unknown> = {}) => ({ name: 'tool-a', kind: 'OPEN_SOURCE_TOOL', gates: [], effort: 2, sources: ['https://example.test/a'], ...over });
const valid = (over: Record<string, unknown> = {}) => ({
  requirementId: 'req-1',
  feasibility: { verdict: 'FEASIBLE', note: 'a public tool exists' },
  methods: [method()],
  sourceInventory: ['https://example.test/a'],
  ...over,
});
const opt = (methods: unknown[]): PreparedOption => validatePreparedOption(valid({ methods }));

describe('validatePreparedOption refuses what is not an option', () => {
  it('accepts a complete option and trims text', () => {
    const o = validatePreparedOption(valid({ requirementId: '  req-1 ', interfaceSketch: { text: ' sketch ', tested: true }, sourceInventory: [] }));
    expect(o.requirementId).toBe('req-1');
    expect(o.interfaceSketch).toEqual({ text: 'sketch', tested: true });
    expect(o.sourceInventory).toBeUndefined();
  });

  it('treats an untested sketch as untested unless tested is exactly true', () => {
    const o = validatePreparedOption(valid({ interfaceSketch: { text: 's', tested: 'yes' } }));
    expect(o.interfaceSketch?.tested).toBe(false);
  });

  const rejections: Array<[string, unknown, RegExp]> = [
    ['null input', null, /requirement/],
    ['missing requirementId', valid({ requirementId: '  ' }), /requirement/],
    ['unknown verdict', valid({ feasibility: { verdict: 'MAYBE', note: 'x' } }), /verdict/],
    ['missing feasibility', valid({ feasibility: undefined }), /verdict/],
    ['blank feasibility note', valid({ feasibility: { verdict: 'FEASIBLE', note: ' ' } }), /note/],
    ['no methods', valid({ methods: [] }), /at least one access method/],
    ['methods not an array', valid({ methods: 'tool' }), /at least one access method/],
    ['unknown gate', valid({ methods: [method({ gates: ['MAGIC'] })] }), /unknown gate MAGIC/],
    ['effort out of range', valid({ methods: [method({ effort: 6 })] }), /effort must be 1\.\.5/],
    ['effort not a number', valid({ methods: [method({ effort: 'low' })] }), /effort must be 1\.\.5/],
    ['unknown kind', valid({ methods: [method({ kind: 'MAGIC' })] }), /unknown kind/],
    ['blank method name', valid({ methods: [method({ name: ' ' })] }), /name is required/],
    ['neither sketch nor inventory', valid({ sourceInventory: [], interfaceSketch: undefined }), /sketch or a source inventory/],
    ['blank sketch and blank inventory', valid({ sourceInventory: [' '], interfaceSketch: { text: ' ', tested: true } }), /sketch or a source inventory/],
  ];
  for (const [name, input, message] of rejections) {
    it(`rejects ${name}`, () => {
      expect(() => validatePreparedOption(input)).toThrow(PreparedOptionError);
      expect(() => validatePreparedOption(input)).toThrow(message);
    });
  }

  it('names the offending method by index', () => {
    expect(() => validatePreparedOption(valid({ methods: [method(), method({ effort: 0 })] }))).toThrow(/method 1:/);
  });

  it('de-duplicates gates and drops blank sources', () => {
    const o = opt([method({ gates: ['SPEND', 'SPEND', 'CONTRACT'], sources: [' ', 'https://example.test/x'] })]);
    expect(o.methods[0]!.gates).toEqual(['SPEND', 'CONTRACT']);
    expect(o.methods[0]!.sources).toEqual(['https://example.test/x']);
  });
});

describe('resolveNeed classifies methods by the gates still closed', () => {
  const cheap = method({ name: 'cheap', effort: 1 });
  const costly = method({ name: 'costly', effort: 4 });
  const credGated = method({ name: 'cred', effort: 1, gates: ['CREDENTIALS'] });
  const multiGated = method({ name: 'multi', effort: 2, gates: ['SPEND', 'CONTRACT'] });

  it('permits only ungated methods, cheapest first, ties by name', () => {
    const r = resolveNeed(opt([costly, method({ name: 'b', effort: 2 }), method({ name: 'a', effort: 2 }), cheap]), { requirementId: 'req-1', goal: 'g' });
    expect(r.permitted.map((m) => m.name)).toEqual(['cheap', 'a', 'b', 'costly']);
    expect(r.minimum?.name).toBe('cheap');
    expect(r.gated).toEqual([]);
    expect(r.needsPerson).toEqual([]);
  });

  it('holds a gated method behind its closed gates and lists them for a person', () => {
    const r = resolveNeed(opt([credGated, multiGated]), { requirementId: 'req-1', goal: 'g' });
    expect(r.permitted).toEqual([]);
    expect(r.minimum).toBeNull();
    expect(r.handoff).toBeNull();
    expect(r.gated.map((g) => [g.method.name, g.gates])).toEqual([['cred', ['CREDENTIALS']], ['multi', ['SPEND', 'CONTRACT']]]);
    expect([...r.needsPerson].sort()).toEqual(['CONTRACT', 'CREDENTIALS', 'SPEND']);
  });

  it('an opened gate moves a method to permitted; a partly opened one stays gated on the rest', () => {
    const r = resolveNeed(opt([credGated, multiGated]), { requirementId: 'req-1', goal: 'g', openGates: ['CREDENTIALS', 'SPEND'] });
    expect(r.permitted.map((m) => m.name)).toEqual(['cred']);
    expect(r.gated).toHaveLength(1);
    expect(r.gated[0]!.gates).toEqual(['CONTRACT']);
    expect(r.needsPerson).toEqual(['CONTRACT']);
  });

  it('a gated method never becomes the minimum while a permitted one exists', () => {
    const r = resolveNeed(opt([credGated, costly]), { requirementId: 'req-1', goal: 'g' });
    expect(r.minimum?.name).toBe('costly');
    expect(r.needsPerson).toEqual(['CREDENTIALS']);
  });

  it('builds an exact handoff naming the requirement, goal and method', () => {
    const r = resolveNeed(opt([cheap]), { requirementId: 'req-1', goal: 'goal-x' });
    expect(r.handoff?.objective).toContain('req-1');
    expect(r.handoff?.objective).toContain('goal-x');
    expect(r.handoff?.objective).toContain('cheap');
    expect(r.handoff?.acceptanceConditions).toHaveLength(2);
  });

  it('with no prepared option there is nothing to hand off and nobody to ask', () => {
    const r = resolveNeed(undefined, { requirementId: 'req-9', goal: 'g' });
    expect(r).toMatchObject({ permitted: [], gated: [], minimum: null, handoff: null, needsPerson: [] });
  });
});

describe('a prepared option is never an integration', () => {
  it('countsAsIntegration is false whatever the option says', () => {
    expect(countsAsIntegration(opt([method()]))).toBe(false);
    expect(countsAsIntegration(validatePreparedOption(valid({ interfaceSketch: { text: 's', tested: true } })))).toBe(false);
  });

  it('warm cost is no workers, and a costly method is refused rather than built', () => {
    const w = warmCost(opt([method({ name: 'ok', effort: COSTLY_EFFORT - 1 }), method({ name: 'browser', effort: COSTLY_EFFORT })]));
    expect(w.workers).toBe(0);
    expect(w.refused).toHaveLength(1);
    expect(w.refused[0]).toContain('browser');
  });

  describe('recorded', () => {
    let projectId: string;
    beforeEach(async () => {
      projectId = (await freshProject()).project.id;
    });

    it('is an event flagged integration:false, and the latest note supersedes for reading only', async () => {
      await recordPreparedOption(projectId, valid());
      await recordPreparedOption(projectId, valid({ feasibility: { verdict: 'UNCERTAIN', note: 'newer' } }));
      const events = (await listEvents(projectId, 100)).filter((e) => e.payload.kind === PREPARED_OPTION_KIND);
      expect(events).toHaveLength(2);
      expect(events.every((e) => e.payload.integration === false)).toBe(true);
      expect((await preparedOptions(projectId)).get('req-1')?.feasibility.note).toBe('newer');
    });

    it('records nothing when the option is invalid', async () => {
      await expect(recordPreparedOption(projectId, valid({ methods: [] }))).rejects.toThrow(PreparedOptionError);
      expect((await listEvents(projectId, 100)).filter((e) => e.payload.kind === PREPARED_OPTION_KIND)).toHaveLength(0);
    });

    it('hands nothing to the Factory when only gated methods exist', async () => {
      const r = resolveNeed(opt([method({ gates: ['CREDENTIALS'] })]), { requirementId: 'req-1', goal: 'g' });
      const out = await handOffToFactory(projectId, r, {
        goal: 'g', repository: 'o/r', baseBranch: 'production', baseSha: 'a'.repeat(40),
        mutationScope: ['server/**'], verificationCommands: ['npm run typecheck'], rollbackRequirement: 'revert',
      });
      expect(out).toBeNull();
    });
  });

  describe('resumption is caused by the handoff, not by any later success (finding F4)', () => {
    const at = (base: string, hours: number): string => new Date(Date.parse(base) + hours * 3_600_000).toISOString();
    const pure = (over: Partial<Parameters<typeof handoffCausedResumption>[0]> = {}) => handoffCausedResumption({
      handedOffAt: '2026-01-01T00:00:00.000Z', changeRequestWithdrawn: false, implementedAt: '2026-01-01T02:00:00.000Z',
      capability: 'WORKING', unitRunTimes: ['2026-01-01T03:00:00.000Z'], ...over,
    });

    it('needs the change implemented, the capability working, and the work run after the implementation', () => {
      expect(pure()).toBe(true);
      expect(pure({ implementedAt: null })).toBe(false);
      expect(pure({ changeRequestWithdrawn: true })).toBe(false);
      expect(pure({ capability: 'UNPROVEN' })).toBe(false);
      expect(pure({ capability: 'BROKEN' })).toBe(false);
      expect(pure({ unitRunTimes: ['2026-01-01T01:00:00.000Z'] })).toBe(false);
      expect(pure({ implementedAt: '2025-12-31T23:00:00.000Z', unitRunTimes: ['2026-01-01T03:00:00.000Z'] })).toBe(false);
      expect(pure({ capability: null })).toBe(true);
    });

    let projectId: string;
    beforeEach(async () => {
      projectId = (await freshProject()).project.id;
    });

    const handOff = async (requirementId: string, blocked: string[]) => {
      const r = resolveNeed(opt([method()]), { requirementId, goal: 'goal-x' });
      const out = await handOffToFactory(projectId, r, {
        goal: 'goal-x', repository: 'o/r', baseBranch: 'production', baseSha: 'a'.repeat(40),
        mutationScope: ['server/**'], verificationCommands: ['npm run typecheck'], rollbackRequirement: 'revert',
        blockedWorkItemIds: blocked,
      });
      return out!.changeRequest.id;
    };
    const blockedItem = async (): Promise<string> =>
      (await enqueueWork({ projectId, workType: 'RESEARCH_AUDIT', payload: { role: 'PRIMARY' }, createdByType: 'SYSTEM' })).id;
    const succeed = async (id: string, completedAt: string): Promise<void> => {
      await getDb().run(`UPDATE work_items SET state = 'SUCCEEDED', completed_at = ? WHERE id = ?`, [completedAt, id]);
    };
    const complete = async (changeRequestId: string, finishedAt: string): Promise<void> => {
      const { campaign } = await ensureCampaign({ changeRequestId, projectId, baseSha: 'a'.repeat(40), laneTarget: 1, laneTargetReason: 'test' });
      await patchCampaign(campaign.id, { state: 'COMPLETE', finishedAt });
    };
    const handedOffAt = async (requirementId: string): Promise<string> => (await resumeOf(projectId, requirementId, ['none'])).handedOffAt!;

    it('a blocked item that succeeds after the handoff, with nothing implemented, is not a resumption and records nothing', async () => {
      const item = await blockedItem();
      await handOff('req-1', [item]);
      await succeed(item, at(await handedOffAt('req-1'), 1));
      const r = await resumeOf(projectId, 'req-1', [item]);
      expect(r.resumed).toBe(false);
      expect(r.implementedAt).toBeNull();
      expect(await advancePreparedOptions()).toMatchObject({ resumed: 0 });
      expect((await listEvents(projectId, 100)).filter((e) => e.payload.kind === PREPARED_RESUMED_KIND)).toHaveLength(0);
    });

    it('work that finished before the campaign completed was not caused by it', async () => {
      const item = await blockedItem();
      const cr = await handOff('req-1', [item]);
      const t0 = await handedOffAt('req-1');
      await succeed(item, at(t0, 1));
      await complete(cr, at(t0, 2));
      expect((await resumeOf(projectId, 'req-1', [item])).resumed).toBe(false);
      await succeed(item, at(t0, 3));
      const r = await resumeOf(projectId, 'req-1', [item]);
      expect(r).toMatchObject({ resumed: true, changeRequestId: cr, implementedAt: at(t0, 2), capability: null, completedAfter: [item] });
      expect(await advancePreparedOptions()).toMatchObject({ resumed: 1 });
      const resumedEvents = (await listEvents(projectId, 100)).filter((e) => e.payload.kind === PREPARED_RESUMED_KIND);
      expect(resumedEvents).toHaveLength(1);
      expect(resumedEvents[0]!.payload.implementedAt).toBe(at(t0, 2));
    });

    it('a withdrawn change request is never a resumption, even with a complete campaign', async () => {
      const item = await blockedItem();
      const cr = await handOff('req-1', [item]);
      const t0 = await handedOffAt('req-1');
      await complete(cr, at(t0, 1));
      await succeed(item, at(t0, 2));
      await getDb().run(`UPDATE factory_change_requests SET state = 'WITHDRAWN' WHERE id = ?`, [cr]);
      expect((await resumeOf(projectId, 'req-1', [item])).resumed).toBe(false);
    });

    it('a mapped requirement must read WORKING over attempts since the implementation', async () => {
      const item = await blockedItem();
      const cr = await handOff('INTAKE.PLAN', [item]);
      const t0 = await handedOffAt('INTAKE.PLAN');
      await complete(cr, at(t0, 0.001));
      await succeed(item, at(t0, 0.01));
      const r = await resumeOf(projectId, 'INTAKE.PLAN', [item], { now: new Date(at(t0, 1)) });
      expect(r.capability?.status).not.toBe('WORKING');
      expect(r.resumed).toBe(false);
      expect(r.completedAfter).toEqual([]);
    });
  });

  describe('the running Brain produces prepared options and handoffs from a goal\'s own record (finding F1)', () => {
    let projectId: string;
    beforeEach(async () => {
      projectId = (await freshProject()).project.id;
    });

    const goal = async (id: string, blocking: string[] | null): Promise<void> => {
      const now = new Date().toISOString();
      await getDb().run(
        `INSERT INTO workstreams (id, project_id, title, intent, purpose, created_at, updated_at, capital_ceiling_cents)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, projectId, 'goal', 'Validate buyers for a $10K plan', 'REVENUE_DIRECT', now, now, 300000],
      );
      if (blocking) {
        await recordEvent({ projectId, entityType: 'WORKSTREAM', entityId: id, eventType: 'CAPABILITY_ASSESSED', payload: { blocking, gaps: [] } });
      }
    };
    const fakeFactory = (): { submit: FactorySubmit; asks: PreparedFactoryAsk[] } => {
      const asks: PreparedFactoryAsk[] = [];
      return {
        asks,
        submit: async (ask) => {
          asks.push(ask);
          const { changeRequest, created } = await ensureChangeRequest({
            projectId, submissionKey: ask.submissionKey, objective: ask.objective, expectedOutcome: ask.expectedOutcome,
            nonGoals: ask.nonGoals,
            acceptanceConditions: ask.acceptanceConditions.map((c, i) => ({ id: `A0${i + 1}`, ...c })),
            repository: 'o/r', repositoryRoot: null, baseBranch: 'production', baseSha: 'a'.repeat(40), environment: 'LOCAL',
            riskClass: 'MEDIUM', mutationScope: ask.mutationScope, deploymentPolicy: 'NONE', rollbackRequirement: 'revert',
            verificationCommands: ['npm run typecheck'],
          });
          return { changeRequestId: changeRequest.id, created };
        },
      };
    };
    const kinds = async (kind: string) => (await listEvents(projectId, 500)).filter((e) => e.payload.kind === kind);

    it('a requirement blocking a live goal is recorded as a prepared option, compared, and handed to the Factory once', async () => {
      await goal('wst_prep', ['BROKEN:ACCESS.READ']);
      const waiting = (await enqueueWork({ projectId, workType: 'RESEARCH_AUDIT', payload: { role: 'PRIMARY' }, createdByType: 'SYSTEM' })).id;
      const factory = fakeFactory();

      const first = await advancePreparedOptions({ submit: factory.submit });
      expect(first).toMatchObject({ prepared: 1, needs: 1, handedOff: 1 });

      const option = (await preparedOptions(projectId)).get('ACCESS.READ')!;
      expect(countsAsIntegration(option)).toBe(false);
      expect(option.methods.find((m) => m.gates.length === 0)?.name).toContain('server/services/sources/access.ts');
      // The map states an external limit: that part is a person's, never forced.
      expect(option.methods.some((m) => m.gates.includes('PERMISSION'))).toBe(true);
      expect((await kinds(PREPARED_OPTION_KIND)).every((e) => e.payload.integration === false)).toBe(true);

      const [need] = await kinds(PREPARED_NEED_KIND);
      expect(need!.payload).toMatchObject({ goalId: 'wst_prep', route: 'PREPARED_HANDOFF', needsPerson: ['PERMISSION'] });

      expect(factory.asks).toHaveLength(1);
      expect(factory.asks[0]!.mutationScope).toContain('server/services/sources/access.ts');
      const [handoff] = await kinds(PREPARED_HANDOFF_KIND);
      expect(handoff!.payload).toMatchObject({ goal: 'wst_prep', integration: false, blockedWorkItemIds: [waiting] });

      // The judge on the same tick now reads a row the running Brain wrote.
      expect((await resumeOf(projectId, 'ACCESS.READ', [waiting])).changeRequestId).toBe(handoff!.payload.changeRequestId);

      const second = await advancePreparedOptions({ submit: factory.submit });
      expect(second).toMatchObject({ prepared: 0, needs: 0, handedOff: 0, judged: 1 });
      expect(factory.asks).toHaveLength(1);
      expect(await kinds(PREPARED_HANDOFF_KIND)).toHaveLength(1);
    });

    it('a requirement the improvement loop routes is prepared and compared but never submitted a second way', async () => {
      await goal('wst_routed', ['BROKEN:DISCOVERY.SEARCH']);
      const factory = fakeFactory();
      expect(await advancePreparedOptions({ submit: factory.submit })).toMatchObject({ prepared: 1, needs: 1, handedOff: 0 });
      expect(factory.asks).toHaveLength(0);
      expect((await kinds(PREPARED_NEED_KIND))[0]!.payload.route).toBe('IMPROVEMENT_LOOP');
    });

    it('a goal with no capability record, or one that names no map requirement, produces nothing', async () => {
      await goal('wst_none', null);
      await goal('wst_unknown', ['MISSING:NOT.A.REQUIREMENT']);
      const factory = fakeFactory();
      expect(await advancePreparedOptions({ submit: factory.submit })).toMatchObject({ prepared: 0, needs: 0, handedOff: 0 });
      expect(factory.asks).toHaveLength(0);
    });

    it('without the Brain repository grant the default path records the option and the need, and hands nothing off', async () => {
      await goal('wst_nogrant', ['BROKEN:ACCESS.READ']);
      expect(await advancePreparedOptions()).toMatchObject({ prepared: 1, needs: 1, handedOff: 0 });
      expect(await kinds(PREPARED_HANDOFF_KIND)).toHaveLength(0);
    });

    it('a map-derived option is a valid option for every requirement on every map', () => {
      for (const map of Object.values(CAPABILITY_MAPS)) {
        for (const requirement of map.requirements) {
          const o = optionFromRequirement(requirement, true);
          expect(o.requirementId).toBe(requirement.id);
          expect(o.interfaceSketch?.tested).toBe(false);
          expect(warmCost(o).workers).toBe(0);
        }
      }
    });
  });
});
