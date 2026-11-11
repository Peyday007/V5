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
  PREPARED_HANDOFF_KIND,
  PREPARED_OPTION_KIND,
  PREPARED_RESUMED_KIND,
  advancePreparedOptions,
  optionFromMap,
  requirementOf,
  type HandoffSubmit,
  PreparedOptionError,
  countsAsIntegration,
  handOffToFactory,
  preparedOptions,
  recordPreparedOption,
  resolveNeed,
  validatePreparedOption,
  warmCost,
  type PreparedOption,
} from '../server/services/capability/prepared.ts';
import { listEvents, recordEvent } from '../server/repos/events.ts';
import { getDb } from '../server/db/database.ts';
import { enqueueWork } from '../server/repos/workQueue.ts';
import { advanceSources } from '../server/services/capability/extraction.ts';

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
});

/*
 * The finding this pins: nothing in the running Brain recorded a prepared
 * option or made a handoff, so every later clause was unreachable. The producer
 * is the Russell tick (`advanceSources` → `advancePreparedOptions` →
 * `prepareFromObjectives`), reading the CAPABILITY_ASSESSED row
 * `assessLiveObjectives` writes on a live goal.
 */
describe('a live goal that needs a dormant capability records, hands off and resumes on the tick', () => {
  // A requirement no improvement route owns, so the loop never routes it itself.
  const DORMANT = 'ACCESS.ROUTINE_FETCH';
  // One the improvement loop owns: never handed off a second time from here.
  const ROUTED = 'DISCOVERY.SEARCH';
  let projectId: string;
  const goalId = 'wst_prepared_goal';

  const assess = async (blocking: string[]) => {
    const now = new Date().toISOString();
    await getDb().run(
      `INSERT INTO workstreams (id, project_id, title, intent, purpose, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
      [goalId, projectId, 'goal', 'Research demand for a plan', 'REVENUE_DIRECT', now, now],
    );
    await recordEvent({ projectId, entityType: 'WORKSTREAM', entityId: goalId, eventType: 'CAPABILITY_ASSESSED', payload: { blocking } });
  };
  const kinds = async (kind: string) => (await listEvents(projectId, 500)).filter((e) => e.payload.kind === kind);

  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
  });

  it('the map-derived option is a source inventory, UNCERTAIN, and not an integration', () => {
    const found = requirementOf(DORMANT)!;
    expect(found.requirement.improvement).toBeUndefined();
    const option = optionFromMap(found.mapKey, found.requirement);
    expect(option.feasibility.verdict).toBe('UNCERTAIN');
    expect(option.sourceInventory).toEqual(expect.arrayContaining(found.requirement.owner));
    expect(option.methods.every((m) => m.effort < COSTLY_EFFORT && m.gates.length === 0)).toBe(true);
    expect(countsAsIntegration(option)).toBe(false);
    expect(requirementOf('NO.SUCH')).toBeNull();
  });

  it('records the option and hands the minimum capability to the Factory once, then judges resumption from rows', async () => {
    const item = await enqueueWork({ projectId, workType: 'RESEARCH_AUDIT', payload: { role: 'PRIMARY' }, requiredScopes: ['queue:claim', 'research:write'], createdByType: 'SYSTEM' });
    await assess([`MISSING:${DORMANT}`, `BROKEN:${ROUTED}`]);
    const asks: Parameters<HandoffSubmit>[0][] = [];
    const submit: HandoffSubmit = async (ask) => { asks.push(ask); return { changeRequestId: 'fcr_test_prepared' }; };

    const first = await advancePreparedOptions({ submit });
    expect(first.prepared).toMatchObject({ goals: 1, recorded: 1, handedOff: 1, routedElsewhere: 1, errors: [] });
    const options = await kinds(PREPARED_OPTION_KIND);
    expect(options).toHaveLength(1);
    expect(options[0]!.entityId).toBe(DORMANT);
    expect(options[0]!.payload.integration).toBe(false);
    expect(asks).toHaveLength(1);
    expect(asks[0]!.requirement.id).toBe(DORMANT);
    expect(asks[0]!.goalId).toBe(goalId);
    expect(asks[0]!.resolution.handoff?.objective).toContain(DORMANT);
    const handoffs = await kinds(PREPARED_HANDOFF_KIND);
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]!.payload).toMatchObject({ integration: false, changeRequestId: 'fcr_test_prepared', goal: goalId, blockedWorkItemIds: [item.id] });
    expect(first.resumed).toBe(0);

    // A second pass re-records nothing and hands off nothing: the rows say it is done.
    const second = await advancePreparedOptions({ submit });
    expect(second.prepared).toMatchObject({ recorded: 0, handedOff: 0 });
    expect(asks).toHaveLength(1);
    expect(second.resumed).toBe(0);

    // The goal's blocked work runs after the handoff: one RESUMED row, once.
    await getDb().run("UPDATE work_items SET state = 'SUCCEEDED', completed_at = ? WHERE id = ?", [new Date(Date.now() + 60_000).toISOString(), item.id]);
    const third = await advancePreparedOptions({ submit });
    expect(third.resumed).toBe(1);
    const resumed = await kinds(PREPARED_RESUMED_KIND);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.payload).toMatchObject({ changeRequestId: 'fcr_test_prepared', completedAfter: [item.id] });
    expect((await advancePreparedOptions({ submit })).resumed).toBe(0);
  });

  it('a BROKEN requirement with a limit outside Brain is recorded but not engineered', async () => {
    await assess(['BROKEN:ACCESS.READ']);
    const submit: HandoffSubmit = async () => { throw new Error('must not be called'); };
    const out = await advancePreparedOptions({ submit });
    expect(out.prepared).toMatchObject({ recorded: 1, handedOff: 0, errors: [] });
  });

  it('the production tick reaches the producer; with no Brain repository grant nothing is handed off', async () => {
    await assess([`MISSING:${DORMANT}`]);
    await advanceSources();
    expect(await kinds(PREPARED_OPTION_KIND)).toHaveLength(1);
    expect(await kinds(PREPARED_HANDOFF_KIND)).toHaveLength(0);
  });
});
