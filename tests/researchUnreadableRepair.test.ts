/**
 * A fragment stopped because its sources could not be read gets an alternative
 * route to the source, or an honest "unresolved" — never the same unreadable
 * pages searched again, and never a rung its envelope does not admit.
 *
 * What is real: the fragment rows, the stored block cause, `retryFragment`
 * persisting the plan it was handed, and the approval envelopes in code.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { listLayers } from '../server/repos/layers.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createFragments,
  createOrchestration,
  currentFragments,
  getFragment,
  listFragments,
  updateFragment,
} from '../server/repos/research.ts';
import {
  RUNG_SOURCE_CLASS,
  UNREADABLE_LADDER,
  buildRepairPlan,
  rungAuthorized,
} from '../server/services/research/repair.ts';
import { getApprovalEnvelope, planFitsEnvelope } from '../server/services/research/approvalEnvelope.ts';
import { retryFragment } from '../server/services/research/reissue.ts';
import type { GateResult } from '../server/services/research/gate.ts';
import type { ResearchFragment } from '../server/domain/types.ts';

let projectId = '';
let layerId = '';

const UNREAD: GateResult = {
  integrity: 'FAIL',
  sufficiency: 'INSUFFICIENT',
  unresolvedRetrieval: [
    { claimId: 'c1', claim: 'a figure', sourceUrl: 'https://legislature.mi.gov/a', state: 'UNREACHABLE' },
    { claimId: 'c2', claim: 'a figure', sourceUrl: 'https://legislature.mi.gov/b', state: 'UNREACHABLE' },
  ],
  claims: [],
  acceptedClaims: 0,
  rejectedClaims: 0,
  independentSources: 0,
  coverage: [],
  duplicateSourceGroups: [],
  failedConditions: [],
  reasons: ['every source was unreadable'],
  unresolvedGaps: [],
};

async function blockedFragment(maxRepairs = 4): Promise<{ fragment: ResearchFragment; orchestrationId: string }> {
  const run = await createRun({
    projectId,
    layerId,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: 'p',
  });
  const orchestration = await createOrchestration({
    projectId,
    layerId,
    runId: run.id,
    title: 't',
    assignment: 'a',
    provider: 'WORKER',
    autoApprove: false,
  });
  await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId,
      layerId,
      fragmentIndex: 0,
      fragmentKey: 'statute',
      question: 'What does the statute say?',
      geography: 'Michigan',
      requiredEvidence: [{ id: 'statute', description: 'the statute text', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['official state statute'],
      excludedSourceTypes: [],
      completionCriteria: ['quoted text'],
      dependsOn: [],
      minIndependentSources: 1,
      maxRepairs,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  const [created] = await currentFragments(orchestration.id);
  await updateFragment(created!.id, {
    status: 'BLOCKED',
    verdictDetail: UNREAD,
    blockedReason: 'every source was unreadable',
    completedAt: new Date().toISOString(),
  });
  return { fragment: (await getFragment(created!.id))!, orchestrationId: orchestration.id };
}

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layerId = (await listLayers(projectId))[0]!.id;
});

describe('the unreadable ladder', () => {
  it('is chosen by the stored cause, and starts with an alternative route to the source', async () => {
    const { fragment } = await blockedFragment();
    expect(fragment.blockCause).toBe('SOURCES_UNREADABLE');
    expect(fragment.blockHost).toBe('legislature.mi.gov');

    const plan = buildRepairPlan({
      fragment,
      gate: UNREAD,
      history: [fragment],
      claims: [],
      splitRequired: false,
      remainingBudget: 4,
      blockCause: 'SOURCES_UNREADABLE',
    });
    expect(plan.strategies).toEqual(['RESOLVE_CANONICAL_LINK', 'INSPECT_ARCHIVED_SOURCES']);
    expect(plan.missingEvidence).toContain('legislature.mi.gov');
    expect(plan.missingEvidence).toContain('do not retry the same addresses');
  });

  it('is not chosen for a fragment whose evidence fell short', async () => {
    const { fragment } = await blockedFragment();
    const plan = buildRepairPlan({
      fragment,
      gate: { ...UNREAD, unresolvedRetrieval: [], failedConditions: ['COVERAGE'] },
      history: [fragment],
      claims: [],
      splitRequired: false,
      remainingBudget: 4,
      blockCause: 'REQUIRED_LANE_EMPTY',
    });
    expect(plan.strategies).toEqual(['FIND_PRIMARY_DATA', 'TRY_DIFFERENT_REPOSITORIES']);
  });

  it('never repeats a rung an earlier attempt used, and ends at a truthful "unresolved"', async () => {
    const { fragment } = await blockedFragment();
    const used = (strategies: ResearchFragment['repairPlan']) => ({ ...fragment, repairPlan: strategies });
    const first = buildRepairPlan({
      fragment, gate: UNREAD, history: [fragment], claims: [], splitRequired: false, remainingBudget: 4,
      blockCause: 'SOURCES_UNREADABLE',
    });
    const second = buildRepairPlan({
      fragment, gate: UNREAD, history: [fragment, used(first)], claims: [], splitRequired: false, remainingBudget: 3,
      blockCause: 'SOURCES_UNREADABLE',
    });
    expect(second.strategies).toEqual(['USE_OFFICIAL_FILINGS', 'TRY_DIFFERENT_REPOSITORIES']);
    expect(second.strategies.some((s) => first.strategies.includes(s))).toBe(false);
    const third = buildRepairPlan({
      fragment, gate: UNREAD, history: [fragment, used(first), used(second)], claims: [], splitRequired: false,
      remainingBudget: 2, blockCause: 'SOURCES_UNREADABLE',
    });
    expect(third.strategies).toEqual(['MARK_UNRESOLVED']);
    expect(UNREADABLE_LADDER.at(-1)).toBe('MARK_UNRESOLVED');
  });

  it('offers only rungs whose source class the envelope already admits', async () => {
    const { fragment } = await blockedFragment();
    const records = getApprovalEnvelope('RUSSELL_PUBLIC_RECORDS_V1')!;
    const cash = getApprovalEnvelope('RUSSELL_CASH_DISCOVERY_V1')!;
    // The public-records envelope admits no web-archive copy; cash discovery does.
    expect(rungAuthorized('INSPECT_ARCHIVED_SOURCES', records)).toBe(false);
    expect(rungAuthorized('INSPECT_ARCHIVED_SOURCES', cash)).toBe(true);

    const plan = buildRepairPlan({
      fragment, gate: UNREAD, history: [fragment], claims: [], splitRequired: false, remainingBudget: 4,
      blockCause: 'SOURCE_ACCESS', envelope: records,
    });
    expect(plan.strategies).toEqual(['RESOLVE_CANONICAL_LINK', 'USE_OFFICIAL_FILINGS']);
  });

  it('leaves the envelope check itself unchanged: a source class it never admitted is still refused', async () => {
    const { fragment, orchestrationId } = await blockedFragment();
    const records = getApprovalEnvelope('RUSSELL_PUBLIC_RECORDS_V1')!;
    const orchestration = { id: orchestrationId, assignment: 'a', title: 't', approvalEnvelopeId: records.id } as never;
    const archived = { ...fragment, acceptableSourceTypes: [RUNG_SOURCE_CLASS.INSPECT_ARCHIVED_SOURCES!] };
    const verdict = planFitsEnvelope({ envelope: records, orchestration, fragments: [archived] });
    expect(verdict.fits).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('does not admit');
  });

  it('persists the plan on the new attempt, so the next plan can see what was used', async () => {
    const { fragment, orchestrationId } = await blockedFragment();
    const plan = buildRepairPlan({
      fragment, gate: UNREAD, history: [fragment], claims: [], splitRequired: false, remainingBudget: 4,
      blockCause: 'SOURCES_UNREADABLE',
    });
    const outcome = await retryFragment({
      fragmentId: fragment.id,
      reason: 'try another route',
      repairPlan: plan,
      actor: { type: 'SYSTEM', id: 'test' },
      advance: false,
    });
    expect(outcome.status).toBe('RETRIED');
    const history = await listFragments(orchestrationId);
    const next = history.find((entry) => entry.attempt === 2)!;
    expect(next.repairPlan?.strategies).toEqual(plan.strategies);

    // The same unreadable failure on the new attempt plans different rungs.
    await updateFragment(next.id, {
      status: 'BLOCKED',
      verdictDetail: UNREAD,
      blockedReason: 'every source was unreadable',
      completedAt: new Date().toISOString(),
    });
    const blocked = (await getFragment(next.id))!;
    const again = buildRepairPlan({
      fragment: blocked, gate: UNREAD, history: await listFragments(orchestrationId), claims: [],
      splitRequired: false, remainingBudget: 3, blockCause: blocked.blockCause as 'SOURCES_UNREADABLE',
    });
    expect(again.strategies.some((s) => plan.strategies.includes(s))).toBe(false);
  });
});
