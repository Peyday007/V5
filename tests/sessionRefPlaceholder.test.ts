/**
 * A `session_ref` that is an unexpanded shell variable is refused, not stored.
 *
 * Production, 2026-10-05 10:22Z: the recovery probe fired at Brain Research A
 * started `cse_01QREme3ZhqPrGpFHpJP6A8o`, whose worker checked in with
 * `session_ref: "$CLAUDE_CODE_REMOTE_SESSION_ID"` — the variable's name rather
 * than its value — and was handed two Cash Mode 1 bins. The probe compared the
 * literal against the session it fired, found nothing, and recorded NO_MCP
 * about a session that had arrived and worked. The same literal from every
 * worker would also be one "session" to the audit-independence floor.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { createBin, getBin, listBinEvents } from '../server/repos/bins.ts';
import { createWorker, grantMembership } from '../server/repos/identity.ts';
import { findTool } from '../server/mcp/tools.ts';
import { isUnexpandedSessionRef } from '../server/domain/sessionRef.ts';
import type { BinManifest, Principal, ProjectMembership } from '../server/domain/types.ts';

const SCOPES = ['queue:read', 'queue:claim', 'queue:heartbeat', 'queue:complete'] as const;

let project: TestProject;
let workerId = '';
let binId = '';

const MANIFEST: BinManifest = {
  objective: 'Return the sha-256 of one value carried in this manifest.',
  why: 'a bounded check',
  lineage: { projectId: '', layerId: null, goal: null, orchestrationId: null },
  units: [{ key: 'echo', establishes: 'answered', input: 'nonce', transform: 'sha256', dependsOn: [] }],
  acceptableSources: [],
  excludedSources: [],
  evidence: ['one unit result'],
  outputs: ['the sha-256'],
  authorizedActions: ['submit the unit result', 'complete this bin'],
  prohibitedActions: ['anything with an external effect'],
  budgetUnits: 1,
  retry: { maxAttempts: 2, backoffSeconds: 30 },
  stoppingConditions: ['the declared unit has a result'],
};

function principal(): Principal {
  return {
    type: 'WORKER',
    id: workerId,
    handle: 'worker-x',
    displayName: 'worker x',
    isBrainAdmin: false,
    mustChangePassword: false,
    credentialId: 'tok_test',
    authMethod: 'WORKER_BEARER',
    memberships: [
      {
        id: 'mem_x',
        projectId: project.project.id,
        principalType: 'WORKER',
        principalId: workerId,
        role: 'MEMBER',
        scopes: [...SCOPES],
        active: true,
        grantedByType: 'SYSTEM',
        grantedById: 'test',
        grantedAt: new Date().toISOString(),
        revokedAt: null,
      } as ProjectMembership,
    ],
    requestId: 'req_x',
  } as Principal;
}

async function checkIn(sessionRef: string | undefined): Promise<Record<string, unknown>> {
  const tool = findTool('brain_check_in')!;
  const outcome = await tool.run(sessionRef === undefined ? {} : { session_ref: sessionRef }, {
    principal: principal(),
    requestId: `req_${Math.random().toString(36).slice(2)}`,
  });
  return outcome.value as Record<string, unknown>;
}

beforeEach(async () => {
  project = await freshProject();
  const worker = await createWorker({ name: 'w-x', displayName: 'w-x', createdByType: 'SYSTEM', createdById: 'test' });
  workerId = worker.id;
  await grantMembership({
    principalType: 'WORKER',
    principalId: worker.id,
    projectId: project.project.id,
    role: 'MEMBER',
    scopes: [...SCOPES],
    grantedByType: 'SYSTEM',
    grantedById: 'test',
  });
  binId = (
    await createBin({
      projectId: project.project.id,
      kind: 'DETERMINISTIC_CHECK',
      title: 'a check',
      objective: 'a check',
      manifest: { ...MANIFEST, lineage: { ...MANIFEST.lineage, projectId: project.project.id } },
      completionContract: 'DETERMINISTIC_UNITS_V1',
      createdByType: 'SYSTEM',
      createdById: 'test',
      ready: true,
      maxAttempts: 2,
    })
  ).id;
});

describe('an unexpanded session_ref', () => {
  it('is recognised as a placeholder, and a real session id is not', () => {
    expect(isUnexpandedSessionRef('$CLAUDE_CODE_REMOTE_SESSION_ID')).toBe(true);
    expect(isUnexpandedSessionRef('${CLAUDE_CODE_REMOTE_SESSION_ID}')).toBe(true);
    expect(isUnexpandedSessionRef('cse_01QREme3ZhqPrGpFHpJP6A8o')).toBe(false);
    expect(isUnexpandedSessionRef('claude-code-session_01QREme3ZhqPrGpFHpJP6A8o')).toBe(false);
    expect(isUnexpandedSessionRef(undefined)).toBe(false);
  });

  it('is ignored rather than refused: the session checks in as one that sent none, and is told the fix', async () => {
    // Refusing it happened before the arrival was recorded, so a session that
    // had reached Brain read as a no-show and quarantined its surface.
    const answer = await checkIn('$CLAUDE_CODE_REMOTE_SESSION_ID');
    expect(answer.assigned).toBe(true);
    expect(String(answer.sessionRefIgnored)).toMatch(/unexpanded variable/);
    const bin = await getBin(binId);
    expect(bin?.state).toBe('LEASED');
    // Nothing stored the placeholder as an identity.
    const events = await listBinEvents(binId);
    expect(events.some((e) => String(e.sessionRef ?? '').includes('$'))).toBe(false);
  });

  it('leaves a real id, and an omitted one, to check in as before', async () => {
    const real = await checkIn('cse_01QREme3ZhqPrGpFHpJP6A8o');
    expect(real.assigned).toBe(true);
    expect(real.binId).toBe(binId);
  });

  it('lets a worker that leaves the field out check in', async () => {
    const omitted = await checkIn(undefined);
    expect(omitted.assigned).toBe(true);
  });
});
