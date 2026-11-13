/**
 * GOV-22-2, finding F2 (repair): a dependency is identified on the key spaces
 * production actually writes.
 *
 * The finding: every recorded option is keyed by a program requirement key
 * (`ACQ-21-5`), but production blocks real work on other keys — a cash need's
 * `CAPABILITY:<cash capability id>` blocker key and `capability:<opp>:<id>`
 * request key, a capability-map id (`CAPABILITY:RESEARCH.ACCESS.READ`), a
 * bin's routing capabilities (`repository`, …). So only program-internal edges
 * ever produced a dependency.
 *
 * Here the open work is raised by production code (`reconcileCapabilityNeeds`
 * over a captured opportunity that requires a capability), never by a row
 * carrying a program key, and the option is recorded by the production
 * producer from an approved program map. The tick finds the dependency itself.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import {
  PREPARED_DEPENDENCY_KIND,
  PREPARED_OPTION_KIND,
  advancePreparedOptions,
  capabilitiesOfRequirement,
  capabilityKeyOf,
  identifyDependencies,
  optionKeys,
  preparedOptionFromRequirement,
  productionCapabilityTerms,
  recordPreparedOption,
  validatePreparedOption,
} from '../server/services/capability/prepared.ts';
import { listEvents } from '../server/repos/events.ts';
import { ensureProgram, insertMapVersion, markProgramApproved } from '../server/repos/factoryProgram.ts';
import { createUser } from '../server/repos/identity.ts';
import { createBin } from '../server/repos/bins.ts';
import { enqueueWork } from '../server/repos/workQueue.ts';
import { listNeeds } from '../server/repos/cashPortfolio.ts';
import { capture } from '../server/services/cash/opportunities.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { reconcileCapabilityNeeds } from '../server/services/cash/operate.ts';
import { raiseNeed } from '../server/services/cash/needs.ts';
import type { ProgramRequirement, RequirementMap } from '../server/domain/factoryProgram.ts';
import type { BinManifest } from '../server/domain/types.ts';

let projectId: string;
let userId: string;

/** Shaped like the map `scripts/program-map-release-01.py` writes for ACQ-21-5. */
const browserRoutines = (over: Partial<ProgramRequirement> = {}): ProgramRequirement => ({
  key: 'ACQ-21-5',
  kind: 'CAPABILITY',
  title: 'Browser routines as versioned reusable capabilities',
  subsystem: 'browser-operator',
  source: ['S-0300'],
  quote: null,
  behavior: 'Browser routines as versioned reusable capabilities. Every quoted clause of the cited source items holds in the running Brain and is demonstrated on production records.',
  inputs: [],
  outputs: [],
  constraints: [
    'Extend the existing owner; no duplicate scheduler, store or authority path (§10.3, §20.4).',
    'No category, industry or example is a whitelist (R01-A1, §18.1).',
    'Gate CREDENTIALS: a browser workflow runs under an account only the owner can sign in to',
    'Gate PERMISSION: each site and workflow must be authorized before it runs in production',
    'Capability PUBLISH_A_LISTING: a marketplace with no publishing API is reached through an authorized browser routine',
    'Capability RESEARCH.ACCESS.READ: a page that only renders in a browser is read through a browser routine',
  ],
  dependsOn: [],
  interactsWith: [],
  existing: { paths: ['.github/workflows/browser.yml'], evidence: 'browser workflow exists.' },
  missingWork: 'Authorized bounded workflows with selectors, checks, secret-free logs and idempotency.',
  paths: ['server/services/sources/browser/**'],
  verification: [],
  ambiguities: [],
  priority: 'P3',
  prepared: true,
  ...over,
});

const approvedProgram = async (requirements: ProgramRequirement[]): Promise<string> => {
  const map = { requirements } as unknown as RequirementMap;
  const { program } = await ensureProgram({
    projectId, submissionKey: `p-${Math.random()}`, title: 'A program', sourceText: 'S-0300 text', sourceSha256: 'x',
    repository: 'https://github.com/o/r', baseBranch: 'main',
  });
  await insertMapVersion({ programId: program.id, version: 1, map, actorType: 'FACTORY', actorId: null, reason: 'test' });
  await markProgramApproved({ programId: program.id, userId, autoRelease: false });
  return program.id;
};

/** A commercial objective that cannot proceed without `capabilities`, raised the way production raises it. */
const blockedOpportunity = async (capabilities: string[]): Promise<string> => {
  const activated = await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash over the next few weeks.' });
  if (!activated.ok) throw new Error('Cash Mode did not activate');
  const captured = await capture({
    projectId, actorRef: userId, ownerUserId: userId, title: 'List an offer on a marketplace',
    mechanism: 'EXPLICIT_PAID_REQUEST', currency: 'USD', requiredCapabilities: capabilities,
  });
  if (!captured.ok) throw new Error(captured.reason);
  await reconcileCapabilityNeeds(projectId);
  return captured.value.id;
};

const manifest = (goal: string): BinManifest => ({
  objective: 'Do the declared thing.',
  why: 'a dependency test',
  lineage: { projectId, layerId: null, goal, orchestrationId: null },
  units: [{ key: 'u', establishes: 'a value', input: '{}', transform: 'sha256', dependsOn: [] }],
  acceptableSources: [], excludedSources: [], evidence: ['a stored value'], outputs: ['one result'],
  authorizedActions: ['submit unit results'], prohibitedActions: ['anything with an external effect'],
  budgetUnits: 1, retry: { maxAttempts: 3, backoffSeconds: 30 }, stoppingConditions: ['the declared unit has a result'],
} as BinManifest);

const kinds = async (kind: string) => (await listEvents(projectId, 500)).filter((e) => e.payload.kind === kind);

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  userId = (await createUser({ email: `keys-${Math.random().toString(36).slice(2, 10)}@test.local`, displayName: 'Owner', password: 'a-long-enough-password', isBrainAdmin: true })).id;
});

describe('a commercial objective blocked on a capability finds the program option that provides it', () => {
  it('production raises the need, production records the option, and the tick identifies the dependency', async () => {
    await approvedProgram([browserRoutines()]);
    const opportunityId = await blockedOpportunity(['PUBLISH_A_LISTING']);

    // The need is production's: keyed by the cash capability, never by a program key.
    const needs = await listNeeds({ projectId, states: ['OPEN'] });
    expect(needs).toHaveLength(1);
    expect(needs[0]).toMatchObject({ blockerKey: 'CAPABILITY:PUBLISH_A_LISTING', requestKey: `capability:${opportunityId}:PUBLISH_A_LISTING` });

    expect(await advancePreparedOptions()).toMatchObject({ recorded: 1 });

    const option = (await kinds(PREPARED_OPTION_KIND))[0]!.payload.option as { requirementId: string; capabilities: string[] };
    expect(option.requirementId).toBe('ACQ-21-5');
    expect(option.capabilities).toEqual(expect.arrayContaining(['PUBLISH_A_LISTING', 'RESEARCH.ACCESS.READ']));

    const deps = (await kinds(PREPARED_DEPENDENCY_KIND)).filter((e) => String(e.payload.sourceRef).startsWith('need:'));
    expect(deps).toHaveLength(1);
    expect(deps[0]!.entityId).toBe('ACQ-21-5');
    expect(deps[0]!.payload).toMatchObject({
      integration: false, sourceRef: `need:${needs[0]!.id}`, via: 'PUBLISH_A_LISTING',
      // The comparison still holds the gates for a person and offers only the internal preparation.
      needsPerson: expect.arrayContaining(['CREDENTIALS', 'PERMISSION']),
    });
    expect(String(deps[0]!.payload.goal)).toContain(opportunityId);

    // Once: a second pass identifies nothing new.
    expect(await advancePreparedOptions()).toMatchObject({ identified: 0 });
  });

  it('an option that declares no capability is still not matched to unrelated production work', async () => {
    await approvedProgram([browserRoutines({ constraints: [] })]);
    await blockedOpportunity(['PUBLISH_A_LISTING']);
    await advancePreparedOptions();
    expect((await kinds(PREPARED_DEPENDENCY_KIND)).filter((e) => String(e.payload.sourceRef).startsWith('need:'))).toEqual([]);
  });

  it('a research objective blocked on a capability-map id is matched by the requirement naming it', async () => {
    const recorded = await recordPreparedOption(projectId, preparedOptionFromRequirement(browserRoutines({
      constraints: [],
      missingWork: 'Give RESEARCH.ACCESS.READ a browser route for pages that only render in one.',
    })));
    const raised = await raiseNeed({
      projectId, actorRef: 'brain', blockedAction: 'Read a source for a research packet', whyItMatters: 'the packet cannot cite it',
      recommendedPath: 'a browser route', setupEffort: 'small', nextStep: 'build it', completionCondition: 'the page reads',
      requestKey: 'research:ACCESS.READ:example', blockerKey: 'CAPABILITY:RESEARCH.ACCESS.READ',
    });
    expect(raised.ok).toBe(true);
    expect(recorded.capabilities).toEqual(['RESEARCH.ACCESS.READ']);
    const deps = await identifyDependencies(projectId, new Map([[recorded.requirementId, recorded]]));
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({ requirementId: 'ACQ-21-5', via: 'RESEARCH.ACCESS.READ' });
    expect(deps[0]!.sourceRef).toMatch(/^need:/);
  });

  it('a bin whose routing capability the option declares is blocked work, whatever the case', async () => {
    const option = validatePreparedOption({
      requirementId: 'ACQ-21-5',
      feasibility: { verdict: 'FEASIBLE', note: 'a browser workflow exists' },
      methods: [{ name: 'existing Factory campaign', kind: 'OTHER', gates: [], effort: 1, sources: [] }],
      sourceInventory: ['.github/workflows/browser.yml'],
      capabilities: ['BROWSER'],
    });
    const bin = await createBin({
      projectId, kind: 'RESEARCH_PACKET', title: 'Needs a browser', objective: 'Read a page that only renders in a browser.',
      manifest: manifest('goal-browser'), completionContract: 'DETERMINISTIC_UNITS_V1', workloadClass: 'RESEARCH',
      requiredCapabilities: ['browser', 'repository'], createdByType: 'SYSTEM', createdById: 'test', ready: true,
    });
    const item = await enqueueWork({ projectId, workType: 'RESEARCH_AUDIT', payload: { role: 'PRIMARY' }, createdByType: 'SYSTEM', binId: bin.id });
    const deps = await identifyDependencies(projectId, new Map([['ACQ-21-5', option]]));
    expect(deps).toEqual([{
      projectId, requirementId: 'ACQ-21-5', sourceRef: `bin:${bin.id}`, goal: 'goal-browser', blockedWorkItemIds: [item.id], via: 'BROWSER',
    }]);
  });
});

describe('the keys an option answers to', () => {
  it('folds the CAPABILITY: prefix and case, and nothing else', () => {
    expect(capabilityKeyOf('CAPABILITY:send_a_message')).toBe('SEND_A_MESSAGE');
    expect(capabilityKeyOf(' repository ')).toBe('REPOSITORY');
    expect(optionKeys({ requirementId: 'ACQ-21-5', capabilities: ['PUBLISH_A_LISTING', 'publish_a_listing'] })).toEqual(['ACQ-21-5', 'PUBLISH_A_LISTING']);
  });

  it('reads declared capabilities, and the production vocabulary named in the requirement words', async () => {
    const vocabulary = await productionCapabilityTerms();
    expect(vocabulary.map((t) => t.id)).toEqual(expect.arrayContaining(['SEND_A_MESSAGE', 'PUBLISH_A_LISTING', 'RESEARCH.ACCESS.READ']));
    const read = capabilitiesOfRequirement({
      title: 'Outreach without an API',
      behavior: 'Brain can send a message to a buyer through a routine.',
      missingWork: 'Bounded workflow.',
      constraints: ['Capability NOT_YET_DESCRIBED: an opportunity may require a capability nobody has described', 'Capability must be bounded'],
    }, vocabulary);
    expect(read.declared).toEqual(['NOT_YET_DESCRIBED']);
    expect(read.named).toEqual(['SEND_A_MESSAGE']);
    expect(read.capabilities).toEqual(['NOT_YET_DESCRIBED', 'SEND_A_MESSAGE']);
  });

  it('a key that is part of a longer key or word is not named', () => {
    const read = capabilitiesOfRequirement({
      title: 'RESEARCH.ACCESS.READ_LATER and RESEARCH.ACCESS.READ.V2', behavior: 'messages are sent', missingWork: '', constraints: [],
    });
    expect(read.capabilities).toEqual([]);
  });

  it('a bin naming a longer key is not a match', async () => {
    const bin = await createBin({
      projectId, kind: 'RESEARCH_PACKET', title: 't', objective: 'o', manifest: manifest('g'), completionContract: 'DETERMINISTIC_UNITS_V1',
      workloadClass: 'RESEARCH', requiredCapabilities: ['browser-write'], createdByType: 'SYSTEM', createdById: 'test', ready: true,
    });
    expect(bin.id).toBeTruthy();
    expect(await identifyDependencies(projectId, new Map([['X', { requirementId: 'X', capabilities: ['browser'] }]]))).toEqual([]);
  });
});
