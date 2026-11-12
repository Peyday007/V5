/**
 * The operator sends a software defect to Factory (§106), through the owner's
 * standing improvement order (§87) and nothing wider.
 *
 * The same entrance the improvement loop uses: `submitObjective` on Brain's own
 * repository, approved by `approveAndStartCampaign({ improvementGrant: true })`
 * — which refuses unless `brain_switches.improvement_loop` is on — and, when a
 * person last set that switch and the scope is LOW risk, the same automatic
 * release the loop grants. `RELEASE_EXCLUDED_PATHS`, review, the gate and the
 * risk class apply exactly as to any objective. The submission key is derived
 * from the problem, so the operator naming the same defect twice reaches the
 * same change request rather than a second campaign.
 */
import { createHash } from 'node:crypto';
import { RELEASE_EXCLUDED_PATHS } from '../../domain/factoryRelease.ts';
import { riskForScope } from '../../domain/improvement.ts';
import { recordEvent } from '../../repos/events.ts';
import { BRAIN_REPOSITORY_REMOTE, brainFactoryProject } from '../improvement/loop.ts';
import { improvementPerson } from '../improvement/authority.ts';

export interface FixRequest {
  title: string;
  problem: string;
  evidence: string;
  ownerPaths: string[];
  acceptance: string;
  runId: string | null;
}

const PATH = /^[A-Za-z0-9_./*-]{1,200}$/;

export function validateFix(input: FixRequest): string | null {
  if (input.title.trim().length < 8) return 'title must say what is wrong in a few words';
  if (input.problem.trim().length < 40) return 'problem must describe the defect and its effect (40+ characters)';
  if (input.evidence.trim().length < 20) return 'evidence must cite rows (ids, verbatim reasons) from Brain';
  if (input.acceptance.trim().length < 20) return 'acceptance must say what a test proves once it is fixed';
  if (input.ownerPaths.length === 0 || input.ownerPaths.length > 8) return 'owner_paths must name 1–8 files or globs that own the behaviour';
  const bad = input.ownerPaths.find((one) => !PATH.test(one) || one.includes('..') || one.startsWith('/'));
  if (bad) return `owner path "${bad}" is not a repository-relative path`;
  return null;
}

export async function submitOperatorFix(input: FixRequest): Promise<{ ok: boolean; reason: string; changeRequestId?: string; campaignId?: string; risk?: string }> {
  const invalid = validateFix(input);
  if (invalid) return { ok: false, reason: invalid };
  const projectId = await brainFactoryProject();
  if (!projectId) return { ok: false, reason: 'No project holds the Brain repository grant for Factory.' };
  const scope = [...new Set([...input.ownerPaths, 'tests/**'])];
  const risk = riskForScope(scope, RELEASE_EXCLUDED_PATHS);
  const key = `operator:${createHash('sha256').update(input.title.trim().toLowerCase()).digest('hex').slice(0, 24)}`;
  const objective =
    `BRAIN OPERATOR FIX: ${input.title.trim()}. ${input.problem.trim()} ` +
    `Evidence from Brain's production rows: ${input.evidence.trim()} ` +
    `The behaviour is owned by ${input.ownerPaths.join(', ')}; extend that owner, do not add a second mechanism. ` +
    'Make the smallest general change that removes the cause for every future case, with a test that reproduces it. ' +
    'Lower no evidence bar, gate or permission.';
  const { submitObjective } = await import('../factory/contract.ts');
  const submitted = await submitObjective({
    projectId,
    objective: objective.slice(0, 7900),
    expectedOutcome: `The defect no longer occurs in production. ${input.acceptance.trim()}`.slice(0, 2000),
    nonGoals: [
      'Lowering, bypassing or reconfiguring the evidence gate, verification, audit or any permission.',
      'Any migration, dependency, secret, identity or deployment-configuration change.',
      'Fixing one row by hand; the change must apply to every future case.',
    ],
    acceptanceConditions: [
      { statement: input.acceptance.trim().slice(0, 600), verification: 'npm test' },
      { statement: 'The repository typechecks and the impacted tests pass.', verification: 'npm run typecheck && npm run test:impacted' },
    ],
    mutationScope: scope,
    riskClass: risk,
    repositoryRemote: BRAIN_REPOSITORY_REMOTE,
    baseBranch: 'production',
    submissionKey: key,
  });
  const { approveAndStartCampaign } = await import('../factory/start.ts');
  const started = await approveAndStartCampaign({ changeRequestId: submitted.changeRequest.id, improvementGrant: true });
  if (!started.ok) {
    await recordEvent({
      projectId,
      entityType: 'PROJECT',
      entityId: projectId,
      eventType: 'OPERATOR_FIX_NOT_STARTED',
      payload: { changeRequestId: submitted.changeRequest.id, reason: started.reason, runId: input.runId, title: input.title },
    });
    return { ok: false, reason: `submitted ${submitted.changeRequest.id}, not started: ${started.reason}`, changeRequestId: submitted.changeRequest.id, risk };
  }
  let release = `released by a person (risk ${started.changeRequest.riskClass})`;
  const person = await improvementPerson();
  if (started.changeRequest.riskClass === 'LOW' && person?.setByPerson) {
    const { authorizeAutomaticRelease } = await import('../factory/release/grant.ts');
    await authorizeAutomaticRelease({
      changeRequestId: started.changeRequest.id,
      userId: person.userId,
      channel: 'SHELL',
      executedByRef: 'operator',
      reason: `Owner's standing improvement order (set by ${person.email}): Factory merges, deploys and verifies LOW-risk Brain fixes the operator sends.`,
      liveChecks: [{ kind: 'HTTP', path: '/healthz', expectStatus: 200 }],
    });
    release = 'automatic release granted (LOW risk)';
  }
  await recordEvent({
    projectId,
    entityType: 'PROJECT',
    entityId: projectId,
    eventType: 'OPERATOR_FIX_SUBMITTED',
    payload: { changeRequestId: submitted.changeRequest.id, campaignId: started.campaign.id, risk, release, runId: input.runId, title: input.title },
  });
  return { ok: true, reason: release, changeRequestId: submitted.changeRequest.id, campaignId: started.campaign.id, risk };
}
