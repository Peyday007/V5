/**
 * GOV-22-2: a prepared option is cheap and is not a production integration.
 *
 * Pins what `server/services/capability/prepared.ts` refuses (validation), how a
 * real need classifies each access method by the gates still closed
 * (`resolveNeed`), and that nothing recorded here ever reads as an integration.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The handoff goes through the Factory's own entrance (`submitObjective`), the
 * only one the tick uses; a second entrance in prepared.ts was finding F3. The
 * entrance and the repository choice are stubbed so a change request is the
 * real row `ensureChangeRequest` writes, with no forge involved.
 */
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
        baseBranch: 'production',
        baseSha: 'a'.repeat(40),
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
  COSTLY_EFFORT,
  PREPARED_OPTION_KIND,
  PREPARED_RESUMED_KIND,
  PreparedOptionError,
  advancePreparedOptions,
  countsAsIntegration,
  gatesOfRequirement,
  handoffCausedResumption,
  identifyPreparedDependencies,
  PREPARED_HANDOFF_KIND,
  preparedOptionFromRequirement,
  resumeOf,
  preparedOptions,
  recordPreparedOption,
  resolveNeed,
  validatePreparedOption,
  warmCost,
  type PreparedOption,
} from '../server/services/capability/prepared.ts';
import { listEvents } from '../server/repos/events.ts';
import { ensureCampaign, patchCampaign } from '../server/repos/factory.ts';
import { enqueueWork } from '../server/repos/workQueue.ts';
import { createBin } from '../server/repos/bins.ts';
import { getDb } from '../server/db/database.ts';
import type { ProgramRequirement } from '../server/domain/factoryProgram.ts';
import type { BinManifest } from '../server/domain/types.ts';

const method = (over: Record<string, unknown> = {}) => ({ name: 'tool-a', kind: 'OPEN_SOURCE_TOOL', gates: [], effort: 2, sources: ['https://example.test/a'], ...over });
const valid = (over: Record<string, unknown> = {}) => ({
  requirementId: 'req-1',
  feasibility: { verdict: 'FEASIBLE', note: 'a public tool exists' },
  methods: [method()],
  sourceInventory: ['https://example.test/a'],
  ...over,
});
const opt = (methods: unknown[]): PreparedOption => validatePreparedOption(valid({ methods }));

/** Open work of a real objective, a bin naming `requirementId`, with one unfinished item: the blocked work the tick finds. */
const blockedBin = async (projectId: string, requirementId: string, goal = 'goal-x'): Promise<{ binId: string; itemId: string }> => {
  const bin = await createBin({
    projectId,
    kind: 'RESEARCH_PACKET',
    title: 'Blocked research',
    objective: 'Establish something that needs the capability.',
    manifest: {
      objective: 'Do the declared thing.', why: 'a prepared-option test',
      lineage: { projectId, layerId: null, goal, orchestrationId: null },
      units: [{ key: 'u', establishes: 'a value', input: '{}', transform: 'sha256', dependsOn: [] }],
      acceptableSources: [], excludedSources: [], evidence: ['a stored value'], outputs: ['one result'],
      authorizedActions: ['submit unit results'], prohibitedActions: ['anything with an external effect'],
      budgetUnits: 1, retry: { maxAttempts: 3, backoffSeconds: 30 }, stoppingConditions: ['the declared unit has a result'],
    } as BinManifest,
    completionContract: 'DETERMINISTIC_UNITS_V1',
    workloadClass: 'RESEARCH',
    requiredCapabilities: [requirementId],
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
  });
  const item = await enqueueWork({ projectId, workType: 'RESEARCH_AUDIT', payload: { role: 'PRIMARY' }, createdByType: 'SYSTEM', binId: bin.id });
  return { binId: bin.id, itemId: item.id };
};

beforeEach(() => {
  submitted.length = 0;
  repositories = [];
});

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

    it('records its warm cost on the event: no worker, and every costly method named as refused', async () => {
      await recordPreparedOption(projectId, valid({ methods: [method({ name: 'ok', effort: 1 }), method({ name: 'browser', effort: COSTLY_EFFORT })] }));
      const [event] = (await listEvents(projectId, 100)).filter((e) => e.payload.kind === PREPARED_OPTION_KIND);
      expect(event!.payload.warm).toEqual({ workers: 0, refused: [expect.stringContaining('browser')] });
      expect(event!.payload.integration).toBe(false);
    });

    it('an option recorded long ago is still read, however many events came after it (finding F3)', async () => {
      await recordPreparedOption(projectId, valid({ requirementId: 'old-req' }));
      const { recordEvent } = await import('../server/repos/events.ts');
      for (let i = 0; i < 1001; i += 1) {
        await recordEvent({ projectId, entityType: 'project', entityId: projectId, eventType: 'CAPABILITY_ASSESSED', payload: { kind: 'NOISE', i } });
      }
      expect((await preparedOptions(projectId)).has('old-req')).toBe(true);
      const blocked = await blockedBin(projectId, 'old-req');
      expect(await identifyPreparedDependencies()).toMatchObject({ identified: 1 });
      const deps = (await listEvents(projectId, 50)).filter((e) => e.payload.sourceRef === `bin:${blocked.binId}`);
      expect(deps).toHaveLength(1);
      expect(deps[0]!.payload.integration).toBe(false);
    });

    it('records nothing when the option is invalid', async () => {
      await expect(recordPreparedOption(projectId, valid({ methods: [] }))).rejects.toThrow(PreparedOptionError);
      expect((await listEvents(projectId, 100)).filter((e) => e.payload.kind === PREPARED_OPTION_KIND)).toHaveLength(0);
    });

    it('hands nothing to the Factory when only gated methods exist', async () => {
      repositories = [{ remote: 'https://github.com/o/r' }];
      await recordPreparedOption(projectId, valid({ methods: [method({ gates: ['CREDENTIALS'] })] }));
      await blockedBin(projectId, 'req-1', 'g');
      expect(await identifyPreparedDependencies()).toMatchObject({ handedOff: 0 });
      expect(submitted).toHaveLength(0);
      expect((await listEvents(projectId, 100)).filter((e) => e.payload.kind === PREPARED_HANDOFF_KIND)).toHaveLength(0);
    });

    it('the module has exactly one Factory entrance, and it is submitObjective (finding F3)', async () => {
      const mod = await import('../server/services/capability/prepared.ts');
      expect('handOffToFactory' in mod).toBe(false);
      const { readFileSync } = await import('node:fs');
      const source = readFileSync(new URL('../server/services/capability/prepared.ts', import.meta.url), 'utf8');
      expect(source).not.toMatch(/\bensureChangeRequest\s*\(/);
      expect(source).toMatch(/\bsubmitObjective\s*\(/);
      for (const name of ['preparedOptions', 'warmCost', 'countsAsIntegration']) {
        const calls = source.match(new RegExp(`(?<!function )\\b${name}\\(`, 'g')) ?? [];
        expect(calls.length, `${name} has a production caller`).toBeGreaterThan(0);
      }
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

    /** The production path: an option is recorded, open work names it, and the tick hands it to the Factory. */
    const handOff = async (requirementId: string): Promise<string> => {
      repositories = [{ remote: 'https://github.com/o/r' }];
      await recordPreparedOption(projectId, valid({ requirementId }));
      expect(await identifyPreparedDependencies()).toMatchObject({ handedOff: 1 });
      const handoff = (await listEvents(projectId, 100)).find((e) => e.payload.kind === PREPARED_HANDOFF_KIND && e.entityId === requirementId);
      expect(handoff!.payload.integration).toBe(false);
      return handoff!.payload.changeRequestId as string;
    };
    const blockedItem = async (requirementId: string): Promise<string> => (await blockedBin(projectId, requirementId)).itemId;
    const succeed = async (id: string, completedAt: string): Promise<void> => {
      await getDb().run(`UPDATE work_items SET state = 'SUCCEEDED', completed_at = ? WHERE id = ?`, [completedAt, id]);
    };
    const complete = async (changeRequestId: string, finishedAt: string): Promise<void> => {
      const { campaign } = await ensureCampaign({ changeRequestId, projectId, baseSha: 'a'.repeat(40), laneTarget: 1, laneTargetReason: 'test' });
      await patchCampaign(campaign.id, { state: 'COMPLETE', finishedAt });
    };
    const handedOffAt = async (requirementId: string): Promise<string> => (await resumeOf(projectId, requirementId, ['none'])).handedOffAt!;

    it('a blocked item that succeeds after the handoff, with nothing implemented, is not a resumption and records nothing', async () => {
      const item = await blockedItem('req-1');
      await handOff('req-1');
      await succeed(item, at(await handedOffAt('req-1'), 1));
      const r = await resumeOf(projectId, 'req-1', [item]);
      expect(r.resumed).toBe(false);
      expect(r.implementedAt).toBeNull();
      expect(await advancePreparedOptions()).toMatchObject({ resumed: 0 });
      expect((await listEvents(projectId, 100)).filter((e) => e.payload.kind === PREPARED_RESUMED_KIND)).toHaveLength(0);
    });

    it('work that finished before the campaign completed was not caused by it', async () => {
      const item = await blockedItem('req-1');
      const cr = await handOff('req-1');
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
      const item = await blockedItem('req-1');
      const cr = await handOff('req-1');
      const t0 = await handedOffAt('req-1');
      await complete(cr, at(t0, 1));
      await succeed(item, at(t0, 2));
      await getDb().run(`UPDATE factory_change_requests SET state = 'WITHDRAWN' WHERE id = ?`, [cr]);
      expect((await resumeOf(projectId, 'req-1', [item])).resumed).toBe(false);
    });

    it('a mapped requirement must read WORKING over attempts since the implementation', async () => {
      const item = await blockedItem('INTAKE.PLAN');
      const cr = await handOff('INTAKE.PLAN');
      const t0 = await handedOffAt('INTAKE.PLAN');
      await complete(cr, at(t0, 0.001));
      await succeed(item, at(t0, 0.01));
      const r = await resumeOf(projectId, 'INTAKE.PLAN', [item], { now: new Date(at(t0, 1)) });
      expect(r.capability?.status).not.toBe('WORKING');
      expect(r.resumed).toBe(false);
      expect(r.completedAfter).toEqual([]);
    });
  });
});

/*
 * Finding F-PROGRAM-OPTION-NO-COMPARISON-NO-GATES: on the production path every
 * option comes from `preparedOptionFromRequirement`, so the comparison and the
 * gates must hold on what that producer emits, not only on hand-built options.
 */
describe('the production producer compares access methods and holds gated routes', () => {
  const requirement = (over: Partial<ProgramRequirement> = {}): ProgramRequirement => ({
    key: 'ACQ-21-5', kind: 'CAPABILITY', title: 'Browser routines as versioned reusable capabilities', subsystem: 'browser-operator',
    source: ['S-0300'], quote: null,
    behavior: 'Browser routines as versioned reusable capabilities. Every quoted clause holds on production records.',
    inputs: [], outputs: [],
    constraints: ['Extend the existing owner; no duplicate scheduler, store or authority path (§10.3, §20.4).'],
    dependsOn: [], interactsWith: [],
    existing: { paths: ['.github/workflows/browser.yml'], evidence: 'browser workflow exists.' },
    missingWork: 'Authorized bounded workflows with selectors, checks, secret-free logs and idempotency.',
    paths: ['server/services/sources/browser/**'],
    verification: [], ambiguities: [], prepared: true,
    ...over,
  });

  it('a requirement with existing code and missing work compares reuse against writing it, cheapest first', () => {
    const o = preparedOptionFromRequirement(requirement({ missingWork: 'Bounded workflows with selectors and checks.' }));
    expect(o.methods).toHaveLength(2);
    expect(o.methods.map((m) => m.effort)).toEqual([1, 2]);
    const r = resolveNeed(o, { requirementId: 'ACQ-21-5', goal: 'g' });
    expect(r.permitted).toHaveLength(2);
    expect(r.minimum?.name).toContain('reusing the existing code');
    expect(r.needsPerson).toEqual([]);
    expect(o.methods.every((m) => m.effort < COSTLY_EFFORT)).toBe(true);
  });

  it('an authorized-account workflow is gated: production routes wait for a person, the internal preparation is handed off', () => {
    const o = preparedOptionFromRequirement(requirement());
    expect(gatesOfRequirement(requirement()).detected).toContain('PERMISSION');
    const production = o.methods.filter((m) => m.gates.length > 0);
    const internal = o.methods.filter((m) => m.gates.length === 0);
    expect(production.length).toBeGreaterThanOrEqual(2);
    expect(internal).toHaveLength(1);
    expect(internal[0]!.name).toContain('internal preparation only');

    const r = resolveNeed(o, { requirementId: 'ACQ-21-5', goal: 'g' });
    expect(r.permitted.map((m) => m.name)).toEqual([internal[0]!.name]);
    expect(r.minimum?.name).toBe(internal[0]!.name);
    expect(r.gated.length).toBe(production.length);
    expect(r.needsPerson).toContain('PERMISSION');
    expect(r.handoff?.objective).toContain('internal preparation only');
    expect(countsAsIntegration(o)).toBe(false);

    // Once the owner opens every gate, the cheapest production route is the minimum again.
    const opened = resolveNeed(o, { requirementId: 'ACQ-21-5', goal: 'g', openGates: r.needsPerson });
    expect(opened.needsPerson).toEqual([]);
    expect(opened.minimum?.name).toContain('reusing the existing code');
  });

  it('reads gates the map declares as `Gate <NAME>: why` constraints, even when the words name none', () => {
    const plain = requirement({ title: 'Read listings', behavior: 'Read listings.', missingWork: 'An adapter.', existing: null, paths: ['server/a.ts'] });
    expect(gatesOfRequirement(plain).gates).toEqual([]);
    expect(preparedOptionFromRequirement(plain).methods).toHaveLength(1);

    const declared = { ...plain, constraints: [...plain.constraints, 'Gate CREDENTIALS: an account only the owner holds', 'gate spend: a paid feed'] };
    const g = gatesOfRequirement(declared);
    expect(g.declared).toEqual(['CREDENTIALS', 'SPEND']);
    expect(g.gates).toEqual(['CREDENTIALS', 'SPEND']);
    const r = resolveNeed(preparedOptionFromRequirement(declared), { requirementId: 'ACQ-21-5', goal: 'g' });
    expect([...r.needsPerson].sort()).toEqual(['CREDENTIALS', 'SPEND']);
    expect(r.permitted).toHaveLength(1);
    expect(r.gated).toHaveLength(1);
  });

  it('detects each gate from the requirement\'s own words', () => {
    const words = (missingWork: string) => gatesOfRequirement({ title: 't', behavior: 'b', missingWork, constraints: [] }).detected;
    expect(words('Sign in to the portal and read the queue.')).toContain('CREDENTIALS');
    expect(words('Role specs; no unapproved hiring.')).toEqual(expect.arrayContaining(['PERMISSION', 'SPEND']));
    expect(words('Draft the supplier agreement.')).toEqual(['CONTRACT']);
    expect(words('Summarize public filings into rows.')).toEqual([]);
  });
});
