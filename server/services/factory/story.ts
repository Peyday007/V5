/**
 * The parts of a campaign a person reading Build needs and the campaign route
 * did not send (Integration 3): why it exists, what counts as success, what it
 * may touch, what the validator changed about its plan, and which repairs came
 * out of review.
 *
 * Composed from rows the factory already writes — the change request, the
 * units, the findings and the `PLAN_REWRITTEN` events `installPlan` records —
 * and stored nowhere. Every sentence is composed here once so the screen never
 * has to turn `MOVE_PATH` into words itself.
 */
import type { FactoryChangeRequest, FactoryFinding, FactoryWorkUnit } from '../../domain/factory.ts';
import { listFactoryEvents } from '../../repos/factoryFleet.ts';
import { FACTORY_EVENT_KINDS } from './metrics.ts';
import { getOpportunity } from '../../repos/cashPortfolio.ts';
import { decideCashRead } from '../cash/access.ts';

export interface CampaignStory {
  /** Who or what started it, in a sentence. */
  origin: string;
  /** The approval route: a person, or the standing authority a person set. */
  approvedVia: 'PERSON' | 'STANDING_AUTHORITY' | null;
  successConditions: { statement: string; verification: string }[];
  scope: string[];
  riskClass: string;
  /** Plain-English account of each change the plan validator made. */
  planRewrites: string[];
  repairs: { unitTitle: string; state: string; finding: string | null }[];
}

const CASH_HANDOFF_PREFIX = 'cash-test-';

/** Pure: one plan rewrite, in words. */
export function describeRewrite(detail: Record<string, unknown>): string {
  const action = String(detail['action'] ?? '');
  const from = String(detail['from'] ?? 'one unit');
  const to = String(detail['to'] ?? 'another');
  const paths = Array.isArray(detail['paths']) ? (detail['paths'] as unknown[]).map(String) : [];
  const files = paths.length ? paths.join(', ') : 'some files';
  if (action === 'MERGE_UNITS') {
    return (
      `Brain merged “${from}” into “${to}”, because the original plan could not finish: ` +
      `${to === from ? 'the units' : 'the two'} needed each other’s files (${files}).`
    );
  }
  if (action === 'MOVE_PATH') {
    return (
      `Brain moved ${files} from “${from}” to “${to}”, because “${to}” needs to change ` +
      'them to finish and the original plan gave them to a unit that runs after it.'
    );
  }
  const reason = typeof detail['detail'] === 'string' ? detail['detail'] : '';
  return reason || 'Brain adjusted the plan so every unit could finish.';
}

export async function campaignStory(input: {
  campaignId: string;
  changeRequest: FactoryChangeRequest;
  units: FactoryWorkUnit[];
  findings: FactoryFinding[];
}): Promise<CampaignStory> {
  const { changeRequest } = input;
  let origin = changeRequest.submittedByUserId
    ? 'A person asked for this build.'
    : 'Brain compiled this build from its own work.';
  if (changeRequest.submissionKey.startsWith(CASH_HANDOFF_PREFIX)) {
    const opportunityId = changeRequest.submissionKey.slice(CASH_HANDOFF_PREFIX.length);
    origin = 'A Cash opportunity that reached “ready to test” needs software, so Brain handed it to the Factory.';
    try {
      const opportunity = await getOpportunity(opportunityId);
      // The title is a private commercial term (§34): named only to somebody
      // who may read the sprint in full.
      if (opportunity && (await decideCashRead(opportunity.projectId)).scope === 'FULL') {
        origin = `Built to test the Cash opportunity “${opportunity.title}”, which reached “ready to test”.`;
      }
    } catch {
      /* the generic sentence stands */
    }
  }

  let planRewrites: string[] = [];
  try {
    const events = await listFactoryEvents(input.campaignId, { kinds: [FACTORY_EVENT_KINDS.planRewritten] });
    planRewrites = events.map((event) => describeRewrite(event.detail));
  } catch {
    planRewrites = [];
  }

  const findingById = new Map(input.findings.map((finding) => [finding.id, finding]));
  const repairs = input.units
    .filter((unit) => unit.repairsFindingId)
    .map((unit) => ({
      unitTitle: unit.title,
      state: unit.state,
      finding: findingById.get(unit.repairsFindingId!)?.statement ?? null,
    }));

  return {
    origin,
    approvedVia: changeRequest.approvedVia,
    successConditions: changeRequest.acceptanceConditions.map((condition) => ({
      statement: condition.statement,
      verification: condition.verification,
    })),
    scope: changeRequest.mutationScope,
    riskClass: changeRequest.riskClass,
    planRewrites,
    repairs,
  };
}
