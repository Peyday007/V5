/**
 * VERIFICATION.REASONS: every claim a judged fragment did not accept says why.
 *
 * The recorded failure was "a rejection with no reason": the gate skips a
 * claim whose source could not be read (it has no verdict on evidence nobody
 * opened), so `gateFragment` never decided it and the row stayed
 * `accepted = 0` with `rejection_reason` NULL — counted as unexplained by the
 * REJECTIONS_EXPLAINED probe. These tests reproduce that class and pin the
 * fix: the row is explained, and the verdict is exactly what it was.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createFragments,
  createOrchestration,
  getFragment,
  insertClaims,
  listClaimsForFragment,
} from '../server/repos/research.ts';
import { gateFragment, type ClaimVerification } from '../server/services/research/submission.ts';
import {
  applyGate,
  GATE_CONDITIONS,
  isUnresolvedRetrievalReason,
} from '../server/services/research/gate.ts';
import type { EvidenceLane, ResearchFragment, RetrievalState } from '../server/domain/types.ts';

const LANES: EvidenceLane[] = [{ id: 'facts', description: 'What the source states', necessity: 'REQUIRED' }];
const MATCH = { geography: 'MATCH', timeframe: 'MATCH', population: 'MATCH', definitions: 'MATCH' } as const;

let fragment: ResearchFragment;
let orchestrationId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  const projectId = fixture.project.id;
  const layer = fixture.layers[0]!;
  const run = await createRun({
    projectId,
    layerId: layer.id,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: 'reasons',
  });
  const orchestration = await createOrchestration({
    projectId,
    layerId: layer.id,
    runId: run.id,
    title: 'reasons',
    assignment: 'reasons',
    provider: 'WORKER',
    autoApprove: false,
  });
  orchestrationId = orchestration.id;
  const [made] = await createFragments([
    {
      orchestrationId,
      projectId,
      layerId: layer.id,
      fragmentIndex: 0,
      fragmentKey: 'facts',
      question: 'What does the source state?',
      requiredEvidence: LANES,
      acceptableSourceTypes: ['primary'],
      excludedSourceTypes: [],
      completionCriteria: ['One sourced fact.'],
      dependsOn: [],
      minIndependentSources: 1,
      status: 'RUNNING',
    },
  ]);
  fragment = made!;
});

async function claims(
  specs: { key: string; state?: RetrievalState; sourced?: boolean; detail?: string | null }[],
): Promise<string[]> {
  const inserted = await insertClaims(
    specs.map((spec, index) => ({
      orchestrationId,
      fragmentId: fragment.id,
      passId: null,
      passKey: 'TARGETED' as const,
      claim: `Claim ${spec.key}`,
      claimType: 'SOURCED_FACT' as const,
      sourceUrl: `https://example${index}.org/${spec.key}`,
      sourceTitle: spec.key,
      sourcePublisher: `Publisher ${index}`,
      sourceDate: '2026-09-01',
      evidenceExcerpt: `Claim ${spec.key}`,
      evidenceLocator: 'p. 1',
      evidenceLane: 'facts',
      retrievedAt: '2026-10-07T12:00:00.000Z',
      confidence: 0.8,
      validationState: spec.sourced === false ? ('NO_EVIDENCE' as const) : ('SOURCED' as const),
      validationDetail: spec.detail ?? null,
      sourced: spec.sourced ?? true,
      retrievalState: spec.state ?? 'RETRIEVED',
      contentHash: `reasons:${spec.key}`,
    })),
  );
  return inserted.map((claim) => claim.id);
}

const supports = (claimId: string): ClaimVerification => ({
  claimId,
  supportsClaim: true,
  scopeMatch: { ...MATCH },
  note: 'The passage states it.',
});

/** The REJECTIONS_EXPLAINED probe's own question, over this fragment. */
async function explained(): Promise<{ total: number; ok: number }> {
  const row = await getDb().get<{ total: number | string; ok: number | string | null }>(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN c.rejection_reason IS NOT NULL AND c.rejection_reason <> '' THEN 1 ELSE 0 END) AS ok
       FROM research_claims c JOIN research_fragments f ON f.id = c.fragment_id
      WHERE c.accepted = 0 AND f.status IN ('ACCEPTED', 'BLOCKED') AND f.id = ?`,
    [fragment.id],
  );
  return { total: Number(row?.total ?? 0), ok: Number(row?.ok ?? 0) };
}

describe('every unaccepted claim of a judged fragment records why', () => {
  it('explains an unread source without counting it as a rejection', async () => {
    const [read, paywalled] = await claims([{ key: 'read' }, { key: 'paywalled', state: 'PAYWALLED' }]);

    // The verdict the gate reaches on the judged claim alone: what the fix must not move.
    const baseline = applyGate({
      fragment,
      claims: (await listClaimsForFragment(fragment.id)).filter((claim) => claim.id === read),
      verification: {
        verdicts: new Map([[read!, { ...supports(read!), scopeBasis: {} }]]),
        sufficiency: 'SUFFICIENT',
        missingLanes: [],
        unresolvedGaps: [],
      },
    });

    const gate = await gateFragment({
      fragment,
      verifications: [supports(read!)],
      sufficiency: 'SUFFICIENT',
      missingLanes: [],
      unresolvedGaps: [],
    });

    // The verdict is unchanged: the unread claim is no rejection.
    expect(gate.integrity).toBe(baseline.integrity);
    expect(gate.sufficiency).toBe(baseline.sufficiency);
    expect(gate.acceptedClaims).toBe(baseline.acceptedClaims);
    expect(gate.rejectedClaims).toBe(baseline.rejectedClaims);
    expect(gate.rejectedClaims).toBe(0);
    expect(gate.claims.map((c) => c.claimId)).toEqual([read]);
    expect(gate.failedConditions).toEqual(baseline.failedConditions);
    expect((await getFragment(fragment.id))?.status).toBe('ACCEPTED');
    expect(gate.unresolvedRetrieval.map((u) => u.claimId)).toEqual([paywalled]);

    // The row says why, and says it is not a refutation.
    const stored = (await listClaimsForFragment(fragment.id)).find((claim) => claim.id === paywalled)!;
    expect(stored.accepted).toBe(false);
    expect(stored.rejectionReason).toMatch(/^UNRESOLVED_RETRIEVAL: .*PAYWALLED.*not judged/);
    expect(isUnresolvedRetrievalReason(stored.rejectionReason)).toBe(true);

    // REJECTIONS_EXPLAINED: every accepted = 0 claim is explained.
    const reading = await explained();
    expect(reading.total).toBe(1);
    expect(reading.ok).toBe(reading.total);
  });

  it('names the failed condition when a rejection arrived with no sentence', async () => {
    const [read, empty] = await claims([
      { key: 'read' },
      { key: 'empty', sourced: false, detail: '' },
      { key: 'blocked', state: 'ROBOTS_BLOCKED' },
    ]);

    const gate = await gateFragment({
      fragment,
      verifications: [supports(read!)],
      sufficiency: 'SUFFICIENT',
      missingLanes: [],
      unresolvedGaps: [],
    });
    // One judged rejection; the unread claim is still not counted.
    expect(gate.rejectedClaims).toBe(1);

    const stored = (await listClaimsForFragment(fragment.id)).find((claim) => claim.id === empty)!;
    expect(stored.accepted).toBe(false);
    expect(stored.rejectionReason).toBe(`GATE_CONDITION LOCATOR: ${GATE_CONDITIONS.LOCATOR} — not met.`);

    const reading = await explained();
    expect(reading.total).toBe(2);
    expect(reading.ok).toBe(reading.total);
  });
});
