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
import { listEvents } from '../server/repos/events.ts';

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
