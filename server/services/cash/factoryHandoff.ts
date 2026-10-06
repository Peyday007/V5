/**
 * READY_TO_TEST → Software Factory. The one owner of that boundary.
 *
 * ---------------------------------------------------------------------------
 * What was missing
 * ---------------------------------------------------------------------------
 *
 * Discovery, the deep dive and the card could carry an opening all the way to
 * READY with nobody pressing anything, and there it stopped: the only code in
 * Cash that ever submitted a Factory objective ran *after* a buyer had agreed
 * and a person had declared a SOFTWARE fulfilment. An opening whose bounded
 * test is a piece of software — a quote tool, an intake form, a landing page
 * the offer is tested through — had no way to reach the Factory at all.
 *
 * ---------------------------------------------------------------------------
 * The rule, every condition from rows
 * ---------------------------------------------------------------------------
 *
 * An opportunity is handed to the Factory when, and only when:
 *
 *   1. the sprint is ACTIVE (a handoff starts new work, so winding down stops it);
 *   2. its stored state is READY and its derived tier is READY_TO_TEST — re-read
 *      here rather than trusted, because a card can lose a fact after it was
 *      marked ready;
 *   3. its card declares `BUILD_SOFTWARE` in `required_capabilities` — a typed
 *      declaration from a closed vocabulary, never inferred from prose;
 *   4. the project's standing commercial authority grants `BUILD_A_TEST` — a
 *      grant a person made first, with its own expiry and revocation;
 *   5. the project has exactly one repository onboarded on Build. None is a
 *      need naming the remedy; two is a need too, because choosing between
 *      them would be Brain deciding which code a test may change.
 *
 * ---------------------------------------------------------------------------
 * What it does, and what it does not
 * ---------------------------------------------------------------------------
 *
 * It submits one objective composed from the card — what is being built, why
 * this opening was selected, the success condition, the exposure ceiling, the
 * evidence it rests on, the constraints and the stop condition — approves it
 * on the standing authority (§16: a plan may be approved without a person only
 * inside limits a person set first; the grant id is recorded on the change
 * request), starts the campaign through the one `approveAndStartCampaign`
 * every entrance uses, and records a `BUILD_A_TEST` action under that grant.
 *
 * It contacts nobody, spends nothing, and merges nothing: the Factory's
 * artifact is a pull request, and merging and deploying it remain a person's.
 * The repository and the directories it may change are the ones a person
 * onboarded for this project; the submission never widens them.
 *
 * Idempotent end to end: the submission key is derived from the opportunity,
 * `ensureCampaign` is one campaign per change request, the action is keyed, and
 * the event is written only by the call that created the action. Two ticks, a
 * restart between steps and a retry all converge on one change request, one
 * campaign and one action.
 */
import { listOpportunities } from '../../repos/cashPortfolio.ts';
import { cardFactsFor } from '../../repos/cashCardFacts.ts';
import { getCashMode, recordCashEvent } from '../../repos/cashMode.ts';
import { recordAction } from '../../repos/cashActions.ts';
import { checkCommercialAuthority } from './authority.ts';
import { raiseNeed } from './needs.ts';
import { cashTier } from './tier.ts';
import { cashEngineCard } from './engineCard.ts';
import { evidenceCard } from './card.ts';
import { ContractError, submitObjective } from '../factory/contract.ts';
import { approveAndStartCampaign } from '../factory/start.ts';
import { repositoryChoicesFor } from '../russell/software.ts';
import type { CashOpportunity } from '../../domain/types.ts';

export const BUILD_CAPABILITY = 'BUILD_SOFTWARE';
export const BUILD_ACTION = 'BUILD_A_TEST';
const BRAIN = 'BRAIN';

export interface FactoryHandoffPass {
  handedOff: { opportunityId: string; changeRequestId: string; campaignId: string }[];
  waiting: { opportunityId: string; reason: string }[];
}

/** The submission key: derived from the opportunity, never from a clock. */
export function handoffKey(opportunityId: string): string {
  return `cash-test-${opportunityId}`;
}

function money(cents: number | null, currency: string): string {
  return cents === null ? 'not established' : `${(cents / 100).toFixed(2)} ${currency}`;
}

/**
 * The objective, composed from the card and from nothing else. Every sentence
 * is a field Brain holds; a field it does not hold says so.
 */
export async function composeTestObjective(opportunity: CashOpportunity): Promise<{
  objective: string;
  expectedOutcome: string;
  nonGoals: string[];
  acceptance: { statement: string; verification: string }[];
}> {
  const facts = await cardFactsFor(opportunity.id);
  const evidence = facts
    .filter((fact) => fact.kind === 'EVIDENCE' && fact.claimId)
    .slice(0, 8)
    .map((fact) => `${fact.field}: ${fact.value.slice(0, 160)} [claim ${fact.claimId}]`);
  const offer = opportunity.offerScope ?? opportunity.title;
  const acceptance = opportunity.acceptanceCondition ?? 'the buyer can use what was built for the offer';
  const objective = [
    `Build the bounded test for the Cash opportunity "${opportunity.title}" (${opportunity.id}).`,
    `What is being built: the software the offer is tested through — ${offer}.`,
    `Why this opening: its card reached READY_TO_TEST on gated evidence` +
      (opportunity.payer ? `; the payer is ${opportunity.payer}` : '') +
      (opportunity.priceCents !== null ? `; the price is ${money(opportunity.priceCents, opportunity.currency)}` : '') +
      '.',
    `Exposure ceiling: ${money(opportunity.peakFundingCents, opportunity.currency)}; this build spends none of it.`,
    evidence.length > 0 ? `Evidence: ${evidence.join(' | ')}` : 'Evidence: the card facts of this opportunity.',
    `Stop condition: stop when the acceptance condition below is met, or when meeting it would ` +
      'need anything outside the repository paths onboarded for this project.',
  ].join('\n');
  return {
    objective,
    expectedOutcome: `A reviewable pull request with which the offer can be tested: ${acceptance}`,
    nonGoals: [
      'Contacting a buyer, publishing, or spending money: those are separate commercial actions.',
      'Merging or deploying: the pull request stays a person’s to merge.',
      'Changing anything outside the repository paths onboarded for this project.',
    ],
    acceptance: [
      {
        statement: acceptance,
        verification: 'The repository’s own checks pass and a reviewer confirms the condition on the diff.',
      },
    ],
  };
}

async function waitOn(
  pass: FactoryHandoffPass,
  opportunity: CashOpportunity,
  reason: string,
  need: { key: string; recommendedPath: string; nextStep: string; completionCondition: string } | null,
): Promise<void> {
  pass.waiting.push({ opportunityId: opportunity.id, reason });
  if (!need) return;
  await raiseNeed({
    projectId: opportunity.projectId,
    opportunityId: opportunity.id,
    actorRef: BRAIN,
    blockedAction: `Hand "${opportunity.title}" to the Software Factory to build its test`,
    whyItMatters: reason,
    recommendedPath: need.recommendedPath,
    setupEffort: 'One action on Build.',
    nextStep: need.nextStep,
    completionCondition: need.completionCondition,
    requestKey: need.key,
  });
}

/**
 * One project's READY_TO_TEST openings, handed to the Factory where the rule
 * above holds. Run on the Cash tick, inside `operate`.
 */
export async function handOffReadyTests(projectId: string): Promise<FactoryHandoffPass> {
  const pass: FactoryHandoffPass = { handedOff: [], waiting: [] };
  const mode = await getCashMode(projectId);
  if (!mode || mode.state !== 'ACTIVE') return pass;

  const ready = await listOpportunities({ projectId, states: ['READY'] });
  for (const opportunity of ready) {
    if (!opportunity.requiredCapabilities.includes(BUILD_CAPABILITY)) continue;

    // The tier, re-derived: a card that lost a fact since it was marked ready
    // is not handed anywhere.
    const card = evidenceCard(opportunity);
    const tier = cashTier({
      opportunity,
      card: cashEngineCard({ opportunity, facts: await cardFactsFor(opportunity.id) }),
      readiness: card.readiness,
    });
    if (tier.tier !== 'READY_TO_TEST') {
      pass.waiting.push({ opportunityId: opportunity.id, reason: `its tier is ${tier.tier}, not READY_TO_TEST` });
      continue;
    }

    const decision = await checkCommercialAuthority({ projectId, action: BUILD_ACTION });
    if (!decision.ok || !decision.authority) {
      await waitOn(pass, opportunity, `Brain may not hand it to the Factory: ${decision.reason}.`, {
        key: `factory-handoff:authority:${opportunity.id}`,
        recommendedPath:
          `Grant ${BUILD_ACTION} on this project's standing commercial authority. It spends nothing; ` +
          'the Factory opens a pull request a person merges.',
        nextStep: `Add ${BUILD_ACTION} to the standing commercial authority on the Cash page.`,
        completionCondition: `The standing commercial authority covers ${BUILD_ACTION}.`,
      });
      continue;
    }

    const choices = await repositoryChoicesFor(projectId);
    if (choices.length !== 1) {
      const reason =
        choices.length === 0
          ? 'this project has no repository onboarded for the Factory'
          : `this project has ${choices.length} repositories onboarded, and choosing which one a test may change is a person's decision`;
      await waitOn(pass, opportunity, `Brain cannot hand it to the Factory: ${reason}.`, {
        key: `factory-handoff:repository:${opportunity.id}`,
        recommendedPath:
          choices.length === 0
            ? 'Onboard the repository the test is built in on Build → Repositories, with the directories it may change.'
            : 'Leave exactly one repository onboarded for this project, or hand the test over by hand on Build.',
        nextStep: 'Onboard one repository for this project on Build.',
        completionCondition: 'Exactly one repository is onboarded for this project.',
      });
      continue;
    }
    const choice = choices[0]!;

    const composed = await composeTestObjective(opportunity);
    let changeRequestId: string;
    try {
      const submitted = await submitObjective({
        projectId,
        objective: composed.objective,
        expectedOutcome: composed.expectedOutcome,
        nonGoals: composed.nonGoals,
        acceptanceConditions: composed.acceptance,
        repositoryRemote: choice.remote,
        submissionKey: handoffKey(opportunity.id),
      });
      changeRequestId = submitted.changeRequest.id;
    } catch (error) {
      if (!(error instanceof ContractError)) throw error;
      await waitOn(pass, opportunity, `The Factory refused the objective: ${error.message}`, {
        key: `factory-handoff:refused:${opportunity.id}`,
        recommendedPath: 'Fix what the Factory named, and Brain submits the objective again on the next pass.',
        nextStep: 'Resolve the Factory’s refusal on Build.',
        completionCondition: 'The Factory accepted the objective for this opportunity.',
      });
      continue;
    }

    const started = await approveAndStartCampaign({
      changeRequestId,
      standingAuthorityId: decision.authority.id,
    });
    if (!started.ok) {
      pass.waiting.push({ opportunityId: opportunity.id, reason: started.reason });
      continue;
    }

    const recorded = await recordAction({
      projectId,
      opportunityId: opportunity.id,
      authorityId: decision.authority.id,
      action: BUILD_ACTION,
      performedBy: 'BRAIN',
      reference: started.campaign.id,
      detail: `Factory campaign ${started.campaign.id} for change request ${changeRequestId}.`,
      confirmedBy: BRAIN,
      requestKey: `factory-handoff:${opportunity.id}`,
    });
    if (recorded.created) {
      await recordCashEvent({
        projectId,
        opportunityId: opportunity.id,
        kind: 'CASH_FACTORY_HANDOFF',
        actorRef: BRAIN,
        summary: `Handed to the Software Factory: campaign ${started.campaign.id}.`,
        detail: {
          changeRequestId,
          campaignId: started.campaign.id,
          authorityId: decision.authority.id,
          repositoryId: choice.repositoryId,
        },
      });
      pass.handedOff.push({ opportunityId: opportunity.id, changeRequestId, campaignId: started.campaign.id });
      // The first stage now, rather than on the Factory loop's next pass.
      try {
        const { tickRemoteCampaign } = await import('../factory/remoteLoop.ts');
        await tickRemoteCampaign(started.campaign.id);
      } catch {
        // The Factory's own loop reads the same rows within twenty seconds.
      }
    }
  }
  return pass;
}
