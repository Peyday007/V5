/**
 * Every claim a judged fragment did not accept records why (VERIFICATION.REASONS).
 *
 * Production read the capability BROKEN at 34/55 (62%, bar 90%) with the
 * recorded reason "a rejection with no reason". The cause: the gate skips a
 * claim whose source could not be read (retrievalState !== 'RETRIEVED') before
 * judging it, so `gateFragment` never wrote a decision for it and the row kept
 * accepted = 0 with rejection_reason NULL — counted by the REJECTIONS_EXPLAINED
 * probe as an unexplained rejection. The fix records a reason from the gate's
 * closed set ("UNRESOLVED_RETRIEVAL: not judged …") without making it a
 * rejection: the verdict, the counts and the rate are unchanged.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject, type TestProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createRun } from '../server/repos/runs.ts';
import {
  createFragments,
  createOrchestration,
  currentFragments,
  getFragment,
  insertClaims,
  listClaimsForFragment,
  type InsertClaimInput,
} from '../server/repos/research.ts';
import { gateFragment } from '../server/services/research/submission.ts';
import {
  GATE_CONDITIONS,
  isUnresolvedRetrievalReason,
  recordedRejectionReason,
  unresolvedRetrievalReason,
} from '../server/services/research/gate.ts';

let fixture: TestProject;

beforeEach(async () => {
  fixture = await freshProject();
});

const MATCHES = { geography: 'MATCH', timeframe: 'MATCH', population: 'MATCH', definitions: 'MATCH' } as const;

async function fragmentWith(claims: Partial<InsertClaimInput>[]) {
  const layer = await fixture.layerByName('World Model');
  const run = await createRun({
    projectId: fixture.project.id, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'p',
  });
  const orchestration = await createOrchestration({
    projectId: fixture.project.id, layerId: layer.id, runId: run.id, title: 'Published prices',
    assignment: 'what each platform publishes', provider: 'WORKER', autoApprove: false,
  });
  await createFragments([
    {
      orchestrationId: orchestration.id, projectId: fixture.project.id, layerId: layer.id,
      requiredEvidence: [{ id: 'published_price', description: 'a price', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['the platform itself'], excludedSourceTypes: ['a blog about it'], completionCriteria: ['one dated price'],
      minIndependentSources: 1, maxRepairs: 2, fragmentIndex: 0, fragmentKey: 'prices', question: 'What does each platform publish?',
      dependsOn: [], attempt: 1,
    },
  ] as unknown as Parameters<typeof createFragments>[0]);
  const fragment = (await currentFragments(orchestration.id))[0]!;
  const stored = await insertClaims(
    claims.map((over, index) => ({
      orchestrationId: orchestration.id, fragmentId: fragment.id, passId: null, passKey: 'TARGETED' as const,
      claim: `Platform ${index} publishes a price.`, sourceUrl: `https://example.invalid/${index}`, sourceTitle: 'Pricing',
      sourcePublisher: `Example ${index}`, sourceDate: '2026-09-01', evidenceExcerpt: 'the price', evidenceLocator: 'pricing page',
      evidenceLane: 'published_price', retrievedAt: '2026-09-01T00:00:00.000Z', confidence: 0.9, validationState: 'SOURCED' as const,
      validationDetail: null, sourced: true, primarySource: true, requirementIds: [], contentHash: `hash-${index}`,
      ...over,
    })),
  );
  return { fragment, stored };
}

/** The REJECTIONS_EXPLAINED probe's own count (server/services/selfmodel/capabilities.ts). */
async function explained(): Promise<{ total: number; ok: number }> {
  const row = await getDb().get<{ total: number | string; ok: number | string | null }>(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN c.rejection_reason IS NOT NULL AND c.rejection_reason <> '' THEN 1 ELSE 0 END) AS ok
       FROM research_claims c JOIN research_fragments f ON f.id = c.fragment_id
      WHERE c.accepted = 0 AND f.status IN ('ACCEPTED', 'BLOCKED')`,
  );
  return { total: Number(row?.total ?? 0), ok: Number(row?.ok ?? 0) };
}

describe('every unaccepted claim of a judged fragment records why', () => {
  it('gives an unread claim the unresolved-retrieval reason without counting it as a rejection', async () => {
    const { fragment, stored } = await fragmentWith([
      {},
      { retrievalState: 'PAYWALLED', claim: 'The regulator publishes guidance behind a paywall.' },
    ]);
    const [read, paywalled] = stored;

    const gate = await gateFragment({
      fragment,
      verifications: [{ claimId: read!.id, supportsClaim: true, scopeMatch: MATCHES, note: 'It says so.' }],
      sufficiency: 'SUFFICIENT',
      missingLanes: [],
      unresolvedGaps: [],
    });

    // The verdict is what it was: the unread claim is not judged, not rejected.
    expect(gate.integrity).toBe('PASS');
    expect(gate.sufficiency).toBe('SUFFICIENT');
    expect(gate.acceptedClaims).toBe(1);
    expect(gate.rejectedClaims).toBe(0);
    expect(gate.failedConditions).toEqual([]);
    expect(gate.claims.map((one) => one.claimId)).toEqual([read!.id]);
    expect(gate.unresolvedRetrieval.map((one) => one.claimId)).toEqual([paywalled!.id]);
    expect((await getFragment(fragment.id))?.status).toBe('ACCEPTED');

    // The failure class: before the fix this row read accepted = 0, rejection_reason NULL.
    const rows = await listClaimsForFragment(fragment.id);
    const unread = rows.find((one) => one.id === paywalled!.id)!;
    expect(unread.accepted).toBe(false);
    expect(unread.rejectionReason).toBe(unresolvedRetrievalReason('PAYWALLED'));
    expect(isUnresolvedRetrievalReason(unread.rejectionReason)).toBe(true);
    expect(unread.rejectionReason).toContain('PAYWALLED');
    expect(rows.find((one) => one.id === read!.id)!.rejectionReason).toBeNull();

    const probe = await explained();
    expect(probe.total).toBe(1);
    expect(probe.ok).toBe(probe.total);
  });

  it('records every unaccepted claim of a blocked fragment with a reason', async () => {
    const { fragment, stored } = await fragmentWith([{}, { retrievalState: 'NOT_REACHABLE' }]);
    await gateFragment({
      fragment,
      verifications: [{ claimId: stored[0]!.id, supportsClaim: false, scopeMatch: MATCHES, note: '' }],
      sufficiency: 'INSUFFICIENT',
      missingLanes: ['published_price'],
      unresolvedGaps: [],
    });
    expect((await getFragment(fragment.id))?.status).toBe('BLOCKED');
    const rows = await listClaimsForFragment(fragment.id);
    expect(rows.every((one) => one.accepted || (one.rejectionReason ?? '').trim().length > 0)).toBe(true);
    const probe = await explained();
    expect(probe.total).toBe(2);
    expect(probe.ok).toBe(2);
  });

  it('gives a rejection whose own sentence is empty a reason naming its failed condition', () => {
    const reason = recordedRejectionReason({ claimId: 'c', accepted: false, failedCondition: 'DERIVATIONS', reason: '' });
    expect(reason).toContain('DERIVATIONS');
    expect(reason).toContain(GATE_CONDITIONS.DERIVATIONS);
    expect(recordedRejectionReason({ claimId: 'c', accepted: false, failedCondition: 'SOURCE_URL', reason: 'No URL.' })).toBe('No URL.');
    expect(recordedRejectionReason({ claimId: 'c', accepted: true, failedCondition: null, reason: null })).toBeNull();
    expect((recordedRejectionReason({ claimId: 'c', accepted: false, failedCondition: null, reason: null }) ?? '').length).toBeGreaterThan(0);
  });
});
