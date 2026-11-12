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
import { RELEASE_EXCLUDED_PATHS } from '../../domain/factoryRelease.ts';
import { riskForScope } from '../../domain/improvement.ts';
import { recordEvent } from '../../repos/events.ts';
import { brainFactoryProject } from '../improvement/loop.ts';

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

export async function submitOperatorFix(input: FixRequest & { goalId?: string | null }): Promise<{ ok: boolean; reason: string; changeRequestId?: string; campaignId?: string; risk?: string; candidateId?: string }> {
  const invalid = validateFix(input);
  if (invalid) return { ok: false, reason: invalid };
  /*
   * §109: a fix is one intervention the engineering director commissions, so it
   * gets what every commissioned change gets — one register row per defect
   * (§87), a priority from what it holds back, a worker class from its
   * complexity, the improvement loop's measurement after delivery and the
   * outcome delivered back to the operator. The tool's own words say the
   * defect recurs and the problem states its cause.
   */
  const { commission } = await import('./director.ts');
  const result = await commission({
    goalId: input.goalId ?? null,
    deficiency: 'RECURRING_OPERATIONAL_FAILURE',
    title: input.title,
    observed: input.problem,
    evidence: input.evidence,
    cause: input.problem,
    ownerPaths: input.ownerPaths,
    recurrence: 2,
    expectedBenefit: `The defect stops recurring in production. ${input.acceptance}`.slice(0, 600),
    acceptance: input.acceptance,
    metric: null,
    blocksGoal: Boolean(input.goalId),
    share: null,
    proposed: 'ENGINEERING',
    runId: input.runId,
  });
  const projectId = await brainFactoryProject();
  if (projectId) {
    await recordEvent({
      projectId,
      entityType: 'PROJECT',
      entityId: projectId,
      eventType: result.campaignId ? 'OPERATOR_FIX_SUBMITTED' : 'OPERATOR_FIX_NOT_STARTED',
      payload: { changeRequestId: result.changeRequestId ?? null, campaignId: result.campaignId ?? null, candidateId: result.candidateId ?? null, intervention: result.intervention, reason: result.reason, runId: input.runId, title: input.title },
    });
  }
  const scope = [...new Set([...input.ownerPaths, 'tests/**'])];
  return {
    ok: result.ok,
    reason: result.reason,
    ...(result.changeRequestId ? { changeRequestId: result.changeRequestId } : {}),
    ...(result.campaignId ? { campaignId: result.campaignId } : {}),
    ...(result.candidateId ? { candidateId: result.candidateId } : {}),
    risk: riskForScope(scope, RELEASE_EXCLUDED_PATHS),
  };
}
