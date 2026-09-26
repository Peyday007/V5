/**
 * The engineering connector, held against the seven behaviours it exists to
 * stop. Each case is a production failure from the brief, stated as the input
 * a worker would send and the answer Brain must give — through the real MCP
 * tools where a row is involved, so an intervention is asserted as a row and
 * not as a return value.
 */
import fs from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { findTool } from '../server/mcp/tools.ts';
import { createAccount, createRoutine } from '../server/repos/fleet.ts';
import { recordRealDelivery } from '../server/repos/deliveryProofs.ts';
import { recordEvidence, interventionMetrics } from '../server/repos/engineering.ts';
import { lookupEvidence } from '../server/services/engineering/evidence.ts';
import {
  MECHANISM_OWNERS,
  duplicateMechanismCheck,
  factoryEnvelope,
  idleCheck,
  nextEngineeringAction,
  preflight,
  readEvidence,
  riskForPaths,
  testPolicy,
} from '../server/domain/engineering.ts';
import type { Principal, ProjectMembership } from '../server/domain/types.ts';
import { FACTORY_WORKER_SCOPES } from '../server/domain/types.ts';

const REPO = 'peyday007/v5';
let projectId: string;

function worker(): Principal {
  return {
    type: 'WORKER',
    id: 'wkr_engineering_test',
    handle: 'worker-eng',
    displayName: 'Engineering test worker',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'cred_eng',
    authMethod: 'WORKER_BEARER',
    memberships: [
      {
        id: 'mem_eng',
        projectId,
        principalType: 'WORKER',
        principalId: 'wkr_engineering_test',
        role: 'MEMBER',
        scopes: [...FACTORY_WORKER_SCOPES],
        active: true,
        grantedByType: 'SYSTEM',
        grantedById: 'test',
        grantedAt: new Date().toISOString(),
        revokedAt: null,
      } as ProjectMembership,
    ],
    requestId: 'req_eng',
  } as Principal;
}

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const tool = findTool(name);
  if (!tool) throw new Error(`no tool ${name}`);
  const outcome = await tool.run(args, { principal: worker(), requestId: 'req_eng' });
  return outcome.value as Record<string, any>;
}

async function interventions(kind: string): Promise<number> {
  const row = await getDb().get<{ n: number | string }>(
    'SELECT COUNT(*) AS n FROM engineering_interventions WHERE kind = ?',
    [kind],
  );
  return Number(row?.n ?? 0);
}

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
});

describe('the seven tools are one surface', () => {
  it('registers all seven in the one registry', () => {
    for (const name of [
      'brain_engineering_preflight',
      'brain_evidence_lookup',
      'brain_evidence_record',
      'brain_test_policy',
      'brain_duplicate_mechanism_check',
      'brain_next_engineering_action',
      'brain_engineering_blocker',
    ]) {
      expect(findTool(name), name).not.toBeNull();
    }
  });

  it('names only owner files that exist, so a hint never points at nothing', () => {
    for (const owner of MECHANISM_OWNERS) {
      for (const file of owner.owners) expect(fs.existsSync(file), file).toBe(true);
    }
  });
});

describe('CASE A — a simple root cause is fixed first', () => {
  it('returns FIX_FIRST, forbids expansion, and records the refusal of the architecture project', async () => {
    const envelope = await call('brain_engineering_preflight', {
      project_id: projectId,
      objective: 'Airyn cannot push V5',
      known_root_cause: 'The Routine is attached to the wrong repository',
      reversible: true,
      blast_radius: 'SMALL',
      proposed_action:
        'Add a migration for delivery proofs, a commissioning command, a synthetic proof system and a router gate',
    });
    expect(envelope.recommendedMode).toBe('FIX_FIRST');
    expect(envelope.architectureExpansionAllowed).toBe(false);
    expect(envelope.investigationBudgetMinutes).toBeLessThanOrEqual(5);
    expect(envelope.proposalRefused).toMatch(/smallest root-cause fix/);
    expect(await interventions('OVERENGINEERING_BLOCKED')).toBe(1);
  });

  it('lets the minimal fix itself through', () => {
    const envelope = preflight({
      objective: 'Airyn cannot push V5',
      knownRootCause: 'wrong repository attached',
      proposedAction: 'change the Routine repository to Peyday007/V5 and retry the unit',
    });
    expect(envelope.proposalRefused).toBeNull();
  });

  it('restores production before anything else', () => {
    expect(preflight({ objective: 'login broken', productionBroken: true }).recommendedMode).toBe('RESTORE_FIRST');
  });
});

describe('CASE B — a full suite on a SHA that already passed', () => {
  it('is refused and the CI evidence is reused', async () => {
    const sha = 'a'.repeat(40);
    for (const backend of ['sqlite', 'postgres']) {
      await recordEvidence({
        repository: REPO,
        propertyKey: `FULL_GATE:${sha}:${backend}`,
        status: 'PROVEN',
        source: 'CI',
        evidenceRef: `github check on ${sha}: success`,
        codeSha: sha,
        recordedByType: 'BRAIN',
        recordedById: 'test',
      });
    }
    const policy = await call('brain_test_policy', {
      project_id: projectId,
      repository: REPO,
      sha,
      changed_paths: ['server/repos/bins.ts'],
      proposes_full_suite: true,
    });
    expect(policy.fullSuite).toBe(false);
    expect(policy.fullSuiteRefused).toMatch(/already has a valid full-gate PASS/);
    expect(await interventions('REDUNDANT_TEST_BLOCKED')).toBe(1);
  });

  it('still runs the release gate once on a SHA that has not passed it', () => {
    const policy = testPolicy({ changedPaths: ['client/src/x.tsx'], releaseSha: true, fullGate: {} });
    expect(policy.fullSuite).toBe(true);
  });

  it('chooses tiers by what changed', () => {
    expect(riskForPaths(['docs/X.md']).tier).toBe('TIER_0');
    expect(riskForPaths(['client/src/a.tsx']).tier).toBe('TIER_1');
    expect(riskForPaths(['server/services/cash/view.ts']).tier).toBe('TIER_2');
    expect(riskForPaths(['server/db/migrations/1.sql']).tier).toBe('TIER_3');
    expect(riskForPaths([]).tier).toBe('TIER_2');
    const persistence = testPolicy({ changedPaths: ['server/repos/bins.ts'] });
    expect(persistence.focusedPostgres).toBe(true);
    expect(testPolicy({ changedPaths: ['docs/A.md'] }).commands).toEqual([]);
  });
});

describe('CASE C — a delayed check on an observable workflow', () => {
  it('says watch it, and records the bad wait', async () => {
    const decision = await call('brain_next_engineering_action', {
      project_id: projectId,
      intended_outcome: 'PRODUCTION_WORKING',
      reached: 'PR_OPEN',
      running_process_observable: true,
      running_process_expected_minutes: 3,
      proposed_wait_minutes: 15,
    });
    expect(decision.action).toBe('WATCH_PROCESS');
    expect(decision.pollSeconds).toBeLessThanOrEqual(60);
    expect(await interventions('BAD_WAIT_BLOCKED')).toBe(1);
  });

  it('starts independent work beside a long observable process', () => {
    const decision = nextEngineeringAction({
      intendedOutcome: 'DEPLOYED',
      reached: 'MERGED',
      runningProcess: { observable: true, expectedMinutes: 25 },
      independentWorkAvailable: true,
    });
    expect(decision.action).toBe('START_NEXT_WORK');
  });
});

describe('CASE D — real work already proved a surface delivers', () => {
  it('reads PROVEN from REAL_PRODUCTION and never asks for a synthetic probe', async () => {
    const account = await createAccount({ name: 'Airyn' });
    const routine = await createRoutine({
      accountId: account.id,
      routineRef: 'trig_surface2',
      name: 'Factory surface 2',
      tokenSecretName: 'BRAIN_TEST_SECRET',
      capabilities: ['repository', 'repository-write'],
    });
    await recordRealDelivery({
      routineId: routine.id,
      repository: 'Peyday007/V5',
      binId: 'bin_real_pr',
      state: 'PROVEN',
      branch: 'factory/fcp_x/u/a1',
      headSha: 'b'.repeat(40),
      pullRequest: 42,
      detail: 'PR_DELIVERED',
      requestedBy: 'factory:delivery',
    });

    const reading = await lookupEvidence({
      repository: REPO,
      propertyKey: 'FACTORY_SURFACE:trig_surface2:repo:peyday007/v5:delivery',
      offline: true,
    });
    expect(reading.status).toBe('PROVEN');
    expect(reading.sourceKind).toBe('REAL_PRODUCTION');
    expect(reading.derivedFrom).toBe('DELIVERY_PROOFS');

    const envelope = await call('brain_engineering_preflight', {
      project_id: projectId,
      repository: REPO,
      objective: 'confirm surface 2 can deliver to V5',
      properties_to_prove: ['FACTORY_SURFACE:trig_surface2:repo:peyday007/v5:delivery'],
      proposed_action: 'run a synthetic probe to prove the surface',
    });
    expect(envelope.proposalRefused).toMatch(/real evidence already proves/);
    expect(await interventions('REAL_EVIDENCE_REUSED')).toBe(1);
  });

  it('ranks real production above a later synthetic failure', () => {
    const at = (t: string) => `2026-09-26T0${t}:00:00.000Z`;
    const reading = readEvidence(
      [
        { status: 'PROVEN', source: 'REAL_PRODUCTION', evidenceRef: 'pr', codeSha: null, configFingerprint: null, provenAt: at('1'), validUntil: null, invalidationScope: [], createdAt: at('1') },
        { status: 'FAILED', source: 'SYNTHETIC', evidenceRef: 'probe', codeSha: null, configFingerprint: null, provenAt: at('2'), validUntil: null, invalidationScope: [], createdAt: at('2') },
      ],
      at('3'),
    );
    expect(reading.status).toBe('PROVEN');
  });

  it('a worker cannot fabricate a production fact', async () => {
    await expect(
      call('brain_evidence_record', {
        project_id: projectId,
        repository: REPO,
        property_key: 'FACTORY_SURFACE:x:repo:peyday007/v5:push',
        status: 'PROVEN',
        source_kind: 'REAL_PRODUCTION',
        evidence_ref: 'trust me',
      }),
    ).rejects.toThrow(/TEST or SYNTHETIC/);
    const first = await call('brain_evidence_record', {
      project_id: projectId,
      repository: REPO,
      property_key: 'TYPECHECK:abc',
      status: 'PROVEN',
      source_kind: 'TEST',
      evidence_ref: 'npm run typecheck exit 0',
      code_sha: 'abc',
    });
    const again = await call('brain_evidence_record', {
      project_id: projectId,
      repository: REPO,
      property_key: 'TYPECHECK:abc',
      status: 'PROVEN',
      source_kind: 'TEST',
      evidence_ref: 'npm run typecheck exit 0',
      code_sha: 'abc',
    });
    expect(first.recorded).toBe(true);
    expect(again.recorded).toBe(false);
  });
});

describe('CASE E — stopping at a PR when the outcome is production', () => {
  it('says CONTINUE and records the prevented stop', async () => {
    const decision = await call('brain_next_engineering_action', {
      project_id: projectId,
      intended_outcome: 'PRODUCTION_WORKING',
      reached: 'PR_OPEN',
      proposing_to_stop: true,
    });
    expect(decision.action).toBe('CONTINUE');
    expect(await interventions('PREMATURE_STOP_PREVENTED')).toBe(1);
    expect(nextEngineeringAction({ intendedOutcome: 'PR_OPEN', reached: 'PR_OPEN' }).action).toBe('DONE');
  });
});

describe('CASE F — a second scheduler', () => {
  it('names the existing tick and records the duplicate', async () => {
    const check = await call('brain_duplicate_mechanism_check', {
      project_id: projectId,
      proposal: 'Build a new scheduler that polls every minute',
    });
    expect(check.extensionPreferred).toBe(true);
    expect(JSON.stringify(check.matches)).toContain('server/services/russell/loop.ts');
    expect(await interventions('DUPLICATE_MECHANISM_BLOCKED')).toBe(1);
    expect(
      duplicateMechanismCheck({
        proposal: 'new scheduler',
        whyExtensionFails: 'it must run on the worker machine, where no Brain tick runs at all, for local git hooks',
      }).newMechanismJustified,
    ).toBe(true);
  });
});

describe('CASE G — idle capacity beside executable work', () => {
  it('is a defect', () => {
    expect(idleCheck({ executableWork: 3, eligibleCapacity: 2, activeWork: 0, safeTarget: 2 }).idle).toBe(true);
    expect(idleCheck({ executableWork: 0, eligibleCapacity: 2, activeWork: 0, safeTarget: 2 }).idle).toBe(false);
    expect(idleCheck({ executableWork: 3, eligibleCapacity: 2, activeWork: 2, safeTarget: 2 }).idle).toBe(false);
  });
});

describe('blockers and the metrics they add up to', () => {
  it('refuses a question for a person that nobody looked up first', async () => {
    const refused = await call('brain_engineering_blocker', {
      project_id: projectId,
      kind: 'HUMAN_DECISION',
      statement: 'Which repository is surface 2 attached to?',
      remedy: 'ask Peyton',
    });
    expect(refused.recorded).toBe(false);
    const accepted = await call('brain_engineering_blocker', {
      project_id: projectId,
      kind: 'MISSING_AUTHORITY',
      statement: 'A new deployment secret is needed',
      remedy: 'an administrator sets it on Fly',
    });
    expect(accepted.needsHuman).toBe(true);
    const metrics = await interventionMetrics();
    expect(metrics.byKind.UNNECESSARY_HUMAN_QUESTION).toBe(1);
    expect(metrics.humanBlockers).toBe(1);
  });
});

describe('Factory bins carry the policy', () => {
  it('builds an envelope that never contradicts the contract', () => {
    const envelope = factoryEnvelope({
      role: 'IMPLEMENT',
      paths: ['client/src/russell/Build.tsx'],
      verificationCommands: ['npm run typecheck'],
    });
    expect(envelope.riskTier).toBe('TIER_1');
    expect(envelope.testPolicy.fullSuite).toBe(false);
    expect(envelope.contractVerification).toEqual(['npm run typecheck']);
    expect(envelope.consult).toContain('brain_test_policy before running tests');
  });

  it('is written into every repository bin manifest', () => {
    const source = fs.readFileSync('server/services/factory/remote.ts', 'utf8');
    expect(source).toMatch(/engineering: factoryEnvelope\(/);
  });
});
