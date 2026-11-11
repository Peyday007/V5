/**
 * GOV-22-2, finding F1: a production entry point records a prepared option.
 *
 * The finding was that `recordPreparedOption` had no caller outside tests, so
 * nothing in the running Brain could write the record every later clause reads.
 * Here nothing calls it: the only inputs are rows — an approved program whose
 * installed map marks a requirement `prepared` — and the tick
 * (`advancePreparedOptions`, called from `advanceSources`) records the option,
 * never as an integration, identifies the live requirement that later depends
 * on it, and reuses the campaign the program's coordinator linked rather than
 * submitting a second one.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import {
  COSTLY_EFFORT,
  PREPARED_DEPENDENCY_KIND,
  PREPARED_HANDOFF_KIND,
  PREPARED_OPTION_KIND,
  PROGRAM_MAP_ORIGIN,
  advancePreparedOptions,
  countsAsIntegration,
  preparedOptionFromRequirement,
  preparedOptions,
  warmCost,
} from '../server/services/capability/prepared.ts';
import { listEvents } from '../server/repos/events.ts';
import { ensureChangeRequest, listChangeRequests } from '../server/repos/factory.ts';
import { ensureProgram, insertMapVersion, insertPlanVersion, linkCampaign, markProgramApproved } from '../server/repos/factoryProgram.ts';
import { createUser } from '../server/repos/identity.ts';
import type { ProgramRequirement, RequirementMap } from '../server/domain/factoryProgram.ts';

let projectId: string;
let approverId: string;

const requirement = (over: Partial<ProgramRequirement> = {}): ProgramRequirement => ({
  key: 'CAP-1',
  kind: 'CAPABILITY',
  title: 'Read a site with no API',
  subsystem: 'research',
  source: ['S-0001'],
  quote: null,
  behavior: 'Brain reads the listing pages of a site that publishes no API.',
  inputs: ['a listing URL'],
  outputs: ['structured rows'],
  constraints: [],
  dependsOn: [],
  interactsWith: [],
  existing: null,
  missingWork: 'An adapter over an existing open-source reader.',
  paths: ['server/services/research/reader.ts'],
  verification: [],
  ambiguities: [],
  ...over,
});

const program = async (map: RequirementMap, approve = true): Promise<string> => {
  const { program } = await ensureProgram({
    projectId, submissionKey: `p-${Math.random()}`, title: 'A program', sourceText: 'S-0001 text', sourceSha256: 'x',
    repository: 'https://github.com/o/r', baseBranch: 'main',
  });
  await insertMapVersion({ programId: program.id, version: 1, map, actorType: 'FACTORY', actorId: null, reason: 'test' });
  if (approve) await markProgramApproved({ programId: program.id, userId: approverId, autoRelease: false });
  return program.id;
};

const kinds = async (kind: string) => (await listEvents(projectId, 500)).filter((e) => e.payload.kind === kind);

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  approverId = (await createUser({ email: `prepared-${Math.random().toString(36).slice(2, 10)}@test.local`, displayName: 'Owner', password: 'a-long-enough-password', isBrainAdmin: true })).id;
});

describe('the option is derived from the requirement and is never an integration', () => {
  it('reads feasibility, the tool inventory and the sketch from the requirement alone', () => {
    const fresh = preparedOptionFromRequirement(requirement());
    expect(fresh).toMatchObject({
      requirementId: 'CAP-1',
      feasibility: { verdict: 'UNCERTAIN', note: 'An adapter over an existing open-source reader.' },
      methods: [{ kind: 'OTHER', gates: [], effort: 2, sources: ['S-0001'] }],
      interfaceSketch: { tested: false },
      sourceInventory: ['source item S-0001'],
    });
    expect(fresh.interfaceSketch!.text).toContain('inputs: a listing URL');
    const reused = preparedOptionFromRequirement(requirement({ existing: { paths: ['server/a.ts'], evidence: 'it exists' } }));
    expect(reused.feasibility.verdict).toBe('FEASIBLE');
    expect(reused.methods[0]!.effort).toBe(1);
    expect(reused.sourceInventory).toContain('server/a.ts');
    for (const o of [fresh, reused]) {
      expect(countsAsIntegration(o)).toBe(false);
      expect(o.methods.every((m) => m.effort < COSTLY_EFFORT)).toBe(true);
      expect(warmCost(o)).toEqual({ workers: 0, refused: [] });
    }
  });
});

describe('the tick records every prepared requirement of an approved program', () => {
  it('records once per map version, with its origin, and nothing for live or unapproved requirements', async () => {
    const programId = await program({ requirements: [requirement({ prepared: true }), requirement({ key: 'LIVE-1' })], context: [] });
    await program({ requirements: [requirement({ key: 'DRAFT-1', prepared: true })], context: [] }, false);

    expect(await advancePreparedOptions()).toMatchObject({ recorded: 1 });
    expect(await advancePreparedOptions()).toMatchObject({ recorded: 0 });

    const recorded = await kinds(PREPARED_OPTION_KIND);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.entityId).toBe('CAP-1');
    expect(recorded[0]!.payload).toMatchObject({ integration: false, origin: { source: PROGRAM_MAP_ORIGIN, programId, mapVersion: 1 } });
    expect([...(await preparedOptions(projectId)).keys()]).toEqual(['CAP-1']);

    // Recorded without consuming a worker: no change request, no dependency, no handoff.
    expect(await listChangeRequests(projectId)).toHaveLength(0);
    expect(await kinds(PREPARED_DEPENDENCY_KIND)).toHaveLength(0);
    expect(await kinds(PREPARED_HANDOFF_KIND)).toHaveLength(0);

    // A new map version is a new reading of the specification, and is recorded again.
    await insertMapVersion({ programId, version: 2, map: { requirements: [requirement({ prepared: true, missingWork: 'newer' })], context: [] }, actorType: 'FACTORY', actorId: null, reason: 'v2' });
    expect(await advancePreparedOptions()).toMatchObject({ recorded: 1 });
    expect((await preparedOptions(projectId)).get('CAP-1')?.feasibility.note).toBe('newer');
  });

  it('when a live requirement comes to depend on it, the dependency is identified and the linked campaign is the handoff', async () => {
    const programId = await program({
      requirements: [requirement({ prepared: true }), requirement({ key: 'LIVE-1', dependsOn: ['CAP-1'] })],
      context: [],
    });
    await insertPlanVersion({
      programId, version: 1, mapVersion: 1, reason: 'test',
      plan: {
        campaigns: [{ key: 'research-d0-prep', kind: 'BUILD', title: 't', subsystem: 'research', implements: ['CAP-1'], dependsOn: [], mutationScope: ['server/**'], repairOf: null }],
        verifyOnly: [], serialized: [],
      },
    });

    // Before the coordinator links a campaign: recorded and identified, nothing submitted.
    expect(await advancePreparedOptions()).toMatchObject({ recorded: 1, identified: 1, handedOff: 0 });
    const dep = await kinds(PREPARED_DEPENDENCY_KIND);
    expect(dep).toHaveLength(1);
    expect(dep[0]!.payload).toMatchObject({ integration: false, sourceRef: `program:${programId}`, minimum: expect.stringContaining('existing Factory campaign') });
    expect(String(dep[0]!.payload.goal)).toContain('LIVE-1');

    const { changeRequest } = await ensureChangeRequest({
      projectId, submissionKey: 'coordinator-campaign', objective: 'implement CAP-1', expectedOutcome: 'CAP-1 works',
      nonGoals: [], acceptanceConditions: [{ id: 'A01', statement: 's', verification: 'v', mandatory: true }],
      repository: 'https://github.com/o/r', repositoryRoot: null, baseBranch: 'main', baseSha: 'b'.repeat(40),
      environment: 'LOCAL', riskClass: 'MEDIUM', mutationScope: ['server/**'], deploymentPolicy: 'NONE',
      rollbackRequirement: 'revert', verificationCommands: ['npm run typecheck'],
    });
    await linkCampaign({ programId, campaignKey: 'research-d0-prep', changeRequestId: changeRequest.id, planVersion: 1 });

    expect(await advancePreparedOptions()).toMatchObject({ recorded: 0, identified: 0, handedOff: 1 });
    expect(await advancePreparedOptions()).toMatchObject({ handedOff: 0 });
    const handoffs = await kinds(PREPARED_HANDOFF_KIND);
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]!.payload).toMatchObject({ integration: false, changeRequestId: changeRequest.id, reused: true, identifiedFrom: `program:${programId}` });
    // Reused, not duplicated: the coordinator's request is the only one.
    expect(await listChangeRequests(projectId)).toHaveLength(1);
  });
});
