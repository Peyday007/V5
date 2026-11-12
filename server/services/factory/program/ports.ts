/**
 * The program coordinator's ports, wired to the machinery that already exists:
 * `submitObjective` for the contract, the line's queue for admission, the
 * release grant for §58's automatic release, `objectiveOutcome` for what a
 * campaign became, and the release verifier's own live checks — run inside the
 * released Brain, exactly as a release is verified — for production evidence.
 */
import { BRAIN_REVISION, PORT } from '../../../env.ts';
import type { RequirementCheck, RequirementVerification } from '../../../domain/factoryProgram.ts';
import { getCampaignByChangeRequest, getChangeRequest, getChangeRequestBySubmissionKey } from '../../../repos/factory.ts';
import { recordFactoryEvent } from '../../../repos/factoryFleet.ts';
import { enqueueChangeRequest } from '../../../repos/factoryLine.ts';
import { approveObjective, submitObjective } from '../contract.ts';
import { LINE_EVENT_KINDS } from '../line.ts';
import { ReleaseGrantError, authorizeAutomaticRelease } from '../release/grant.ts';
import { objectiveOutcome } from '../release/outcome.ts';
import { runLiveCheck, type VerifyDeps } from '../release/verify.ts';
import type { ProgramPorts } from './coordinator.ts';
import { getProbe } from './probes.ts';

/** Run one requirement's checks in this process, against its own port and rows. */
export async function runRequirementChecks(
  checks: RequirementCheck[],
  deps: Pick<VerifyDeps, 'baseUrl' | 'fetch'> = { baseUrl: `http://127.0.0.1:${PORT}`, fetch },
): Promise<RequirementVerification['checks']> {
  const verifyDeps: VerifyDeps = { ...deps, revision: BRAIN_REVISION, contains: async () => null };
  const results: RequirementVerification['checks'] = [];
  for (const check of checks) {
    if (check.kind === 'PROBE') {
      const probe = getProbe(check.probe);
      const label = `probe ${check.probe}`;
      if (!probe) {
        results.push({ check: label, ok: null, detail: 'no such probe is registered in this Brain' });
        continue;
      }
      try {
        const answer = await probe(check.args ?? {});
        results.push({ check: label, ok: answer.ok, detail: answer.detail });
      } catch (error) {
        results.push({ check: label, ok: false, detail: error instanceof Error ? error.message.slice(0, 200) : String(error) });
      }
      continue;
    }
    const live = check.kind === 'HTTP'
      ? { kind: 'HTTP' as const, path: check.path, expectStatus: check.expectStatus, ...(check.expectText ? { expectText: check.expectText } : {}) }
      : { kind: 'BUNDLE_TEXT' as const, text: check.text };
    const result = await runLiveCheck(verifyDeps, live);
    results.push({ check: result.check, ok: result.ok, detail: result.detail });
  }
  return results;
}

export function productionPorts(): ProgramPorts {
  return {
    async submit(input) {
      const existing = await getChangeRequestBySubmissionKey(input.projectId, input.submissionKey);
      if (existing) return { changeRequestId: existing.id, riskClass: existing.riskClass };
      const result = await submitObjective({
        projectId: input.projectId,
        objective: input.objective,
        expectedOutcome: input.expectedOutcome,
        nonGoals: input.nonGoals,
        acceptanceConditions: input.acceptanceConditions,
        mutationScope: input.mutationScope,
        repositoryRemote: input.repository,
        baseBranch: input.baseBranch,
        submissionKey: input.submissionKey,
      });
      return { changeRequestId: result.changeRequest.id, riskClass: result.changeRequest.riskClass };
    },
    async queue(input) {
      if (await getCampaignByChangeRequest(input.changeRequestId)) return;
      // The program's approver approved this campaign in advance, when they approved the program.
      const approval = await approveObjective({ changeRequestId: input.changeRequestId, via: 'PERSON', userId: input.userId });
      if (!approval.ok) throw new Error(approval.reason ?? 'the campaign could not be approved');
      const { entry, created } = await enqueueChangeRequest({ ...input, queuedByUserId: input.userId });
      if (created) {
        await recordFactoryEvent({
          kind: LINE_EVENT_KINDS.queued,
          evidenceClass: 'MEASURED',
          detail: { changeRequestId: input.changeRequestId, entryId: entry.id, priority: entry.priority, via: 'program' },
        });
      }
    },
    async authorizeRelease(input) {
      try {
        await authorizeAutomaticRelease({
          changeRequestId: input.changeRequestId,
          userId: input.userId,
          channel: 'SHELL',
          executedByRef: 'factory-program',
          reason: input.reason,
          liveChecks: input.liveChecks,
        });
      } catch (error) {
        // A campaign the gate will not release by itself finishes at a pull request.
        if (!(error instanceof ReleaseGrantError)) throw error;
      }
    },
    async extendScope(input) {
      const changeRequest = await getChangeRequest(input.changeRequestId);
      if (!changeRequest) return;
      const missing = input.add.filter((path) => !changeRequest.mutationScope.includes(path));
      if (missing.length === 0) return;
      const { amendContract } = await import('../contract.ts');
      const campaign = await getCampaignByChangeRequest(input.changeRequestId);
      const result = await amendContract({
        changeRequestId: input.changeRequestId,
        campaignId: campaign?.id ?? null,
        field: 'mutation_scope',
        newValue: [...changeRequest.mutationScope, ...missing],
        reason: input.reason,
        actorType: 'PERSON',
        actorId: input.userId,
        affectedWork: [],
      });
      if (!result.ok) throw new Error(result.reason);
    },
    async riskOf(changeRequestId) {
      return (await getChangeRequest(changeRequestId))?.riskClass ?? null;
    },
    async progressOf(changeRequestId) {
      const campaign = await getCampaignByChangeRequest(changeRequestId);
      if (!campaign) {
        return { changeRequestId, campaignId: null, outcome: null, delivered: false, needsPerson: false, blocker: null };
      }
      const outcome = await objectiveOutcome(campaign);
      return {
        changeRequestId,
        campaignId: campaign.id,
        outcome: outcome.status,
        delivered: campaign.prUrl !== null || campaign.state === 'COMPLETE',
        needsPerson: outcome.needsPerson,
        blocker: outcome.blocker ?? outcome.personAction ?? null,
      };
    },
    async verify(checks) {
      return { revision: BRAIN_REVISION, checks: await runRequirementChecks(checks) };
    },
    revision: () => BRAIN_REVISION,
    now: () => new Date(),
  };
}
