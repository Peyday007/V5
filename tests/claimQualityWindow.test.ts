/**
 * A claim is judged after it is written, and the GPU report must count it
 * where it was judged (production, 2026-11-18): the GPU's 16 claims were
 * submitted 15:22–15:24Z and all accepted at 16:25Z, and the hourly report,
 * windowed by submission, printed "no accepted GPU claims" for both hours.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createRun } from '../server/repos/runs.ts';
import { claimQualityByModel, createFragments, createOrchestration, currentFragments, decideClaim, insertClaims, updateFragment } from '../server/repos/research.ts';
import { enqueueWork } from '../server/repos/workQueue.ts';
import { recordBinEvent } from '../server/repos/bins.ts';
import { workType } from '../server/services/queue/workTypes.ts';
import { getDb } from '../server/db/database.ts';
import type { Layer } from '../server/domain/types.ts';

describe('claim quality by model is counted where the gate ruled', () => {
  let projectId = '';
  let layer: Layer;
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

  beforeEach(async () => {
    const fixture = await freshProject();
    projectId = fixture.project.id;
    layer = await fixture.layerByName('Discovery Logic');
  });

  /** A fragment a model submitted `submittedHoursAgo`, with `n` claims, gated `gatedHoursAgo` (null: not yet). */
  async function fragment(model: string, n: number, submittedHoursAgo: number, gatedHoursAgo: number | null): Promise<void> {
    const run = await createRun({ projectId, layerId: layer.id, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'q' });
    const orchestration = await createOrchestration({ projectId, layerId: layer.id, runId: run.id, title: 'q', assignment: 'q', provider: 'WORKER', autoApprove: false });
    await createFragments([
      {
        orchestrationId: orchestration.id, projectId, layerId: layer.id, geography: null,
        requiredEvidence: [{ id: 'timing', description: 'when money arrives', necessity: 'CONDITIONAL' }],
        acceptableSourceTypes: ['a terms page'], excludedSourceTypes: [], completionCriteria: ['a dated term'],
        minIndependentSources: 1, maxRepairs: 2, fragmentIndex: 0, fragmentKey: 'k', question: 'q', dependsOn: [], attempt: 1,
      },
    ] as unknown as Parameters<typeof createFragments>[0]);
    const [frag] = await currentFragments(orchestration.id);
    const claims = await insertClaims(
      Array.from({ length: n }, (_, i) => ({
        orchestrationId: orchestration.id, fragmentId: frag!.id, passId: null, passKey: 'BROAD_SCAN' as const,
        claim: `claim ${i}`, sourceUrl: `https://example.test/${i}`, sourceTitle: 't', sourcePublisher: 'p', sourceDate: null,
        evidenceExcerpt: 'x', evidenceLocator: 'sentence 1', evidenceLane: 'timing', opportunitySignal: null, closesOn: null,
        retrievedAt: null, confidence: 0.8, validationState: 'SOURCED' as const, validationDetail: null, sourced: true,
        claimType: 'SOURCED_FACT' as const, contentHash: `${orchestration.id}|${i}`,
      })),
    );
    if (gatedHoursAgo !== null) {
      for (const claim of claims) await decideClaim(claim.id, { accepted: true });
      await updateFragment(frag!.id, { status: 'ACCEPTED', completedAt: hoursAgo(gatedHoursAgo), blockedReason: null });
    }
    const item = await enqueueWork({
      projectId, workType: 'RESEARCH_FRAGMENT', payload: workType('RESEARCH_FRAGMENT').validate({}),
      orchestrationId: orchestration.id, fragmentId: frag!.id, createdByType: 'SYSTEM',
    });
    // Submitted twice (a retried lease): each claim still counts once.
    for (let i = 0; i < 2; i += 1) {
      await recordBinEvent({
        eventType: 'FREE_LANE_ITEM', projectId, workItemId: item.id, workloadClass: 'RESEARCH_FRAGMENT',
        outcome: 'SUBMITTED', reason: `model ${model}`, durationMs: 1000, evidenceClass: 'MEASURED',
      } as Parameters<typeof recordBinEvent>[0]);
    }
    await getDb().run('UPDATE bin_events SET at = ? WHERE work_item_id = ?', [hoursAgo(submittedHoursAgo), item.id]);
  }

  it('counts claims submitted before the window and accepted in it, and none twice', async () => {
    const gpu = 'runpod/openai/gpt-oss-120b';
    await fragment(gpu, 3, 1.5, 0.5); // submitted last hour, accepted this hour
    await fragment(gpu, 2, 0.5, null); // submitted this hour, not judged yet
    await fragment(gpu, 4, 5, 4); // submitted and accepted before the window
    const since = hoursAgo(1);
    const rows = await claimQualityByModel(since);
    const row = rows.find((one) => one.reason === `model ${gpu}`);
    expect(row).toMatchObject({ claims: 5, sourced: 5, accepted: 3, refuted: 0, acceptedRefuted: 0 });
    // The window before it saw the first fragment's claims unjudged, and the third's accepted.
    const before = (await claimQualityByModel(hoursAgo(6))).find((one) => one.reason === `model ${gpu}`);
    expect(before).toMatchObject({ claims: 9, accepted: 7 });
  });
});
