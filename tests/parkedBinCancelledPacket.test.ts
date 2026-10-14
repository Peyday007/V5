/**
 * A parked research bin whose packet was cancelled is waiting on nobody.
 *
 * Production, 2026-10-13: `bin_2b9db512cef74f4ba518` sat at NEEDS_HUMAN saying
 * "A person must decide: The packet is CANCELLED…" under the cancelled
 * `orc_c576fa7b25b348c69249`, and `reconcileBins` asked to reopen it and was
 * refused on every tick for six days. A FAILED packet is different — a person
 * may redo it — and stays parked.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshProject, teardown } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createBin, getBin, listBinEvents } from '../server/repos/bins.ts';
import { createOrchestration } from '../server/repos/research.ts';
import { createRun } from '../server/repos/runs.ts';
import { reconcileBins } from '../server/services/bins/service.ts';

describe('a parked research bin under a terminal packet', () => {
  let projectId = '';
  let layerId = '';

  beforeEach(async () => {
    const fixture = await freshProject();
    projectId = fixture.project.id;
    layerId = (await fixture.layerByName('Monetization Logic')).id;
  });
  afterEach(async () => {
    await teardown();
  });

  async function parkedBinUnder(status: string): Promise<{ binId: string; packetId: string }> {
    const run = await createRun({ projectId, layerId, runType: 'FOUNDATION', provider: 'WORKER' });
    const packet = await createOrchestration({
      projectId,
      layerId,
      runId: run.id,
      title: 'A question nobody wants answered any more',
      assignment: 'Answer one question.',
      provider: 'WORKER',
    });
    await getDb().run('UPDATE research_orchestrations SET status = ? WHERE id = ?', [status, packet.id]);
    const bin = await createBin({
      projectId,
      kind: 'RESEARCH_PACKET',
      title: 'Research packet',
      objective: 'Carry the packet.',
      orchestrationId: packet.id,
      manifest: {
        objective: 'Carry the packet.',
        why: 'Test.',
        lineage: { projectId, layerId, goal: null, orchestrationId: packet.id },
        units: [],
        acceptableSources: [],
        excludedSources: [],
        evidence: [],
        outputs: [],
        authorizedActions: [],
        prohibitedActions: [],
        budgetUnits: 1,
        retry: { maxAttempts: 5, backoffSeconds: 30 },
        stoppingConditions: [],
      },
      completionContract: 'RESEARCH_PACKET_V1',
      createdByType: 'SYSTEM',
      createdById: 'test',
      ready: true,
    } as Parameters<typeof createBin>[0]);
    await getDb().run(
      `UPDATE bins SET state = 'NEEDS_HUMAN', attempt_count = 1, terminal_reason = ? WHERE id = ?`,
      [`A person must decide: The packet is ${status}, which is not a state it files a report in.`, bin.id],
    );
    return { binId: bin.id, packetId: packet.id };
  }

  it('closes the bin with its CANCELLED packet, keeping its history', async () => {
    const { binId, packetId } = await parkedBinUnder('CANCELLED');
    const report = await reconcileBins(projectId);
    const bin = await getBin(binId);
    expect(bin?.state).toBe('CANCELLED');
    expect(bin?.terminalReason).toContain(packetId);
    expect(bin?.attemptCount).toBe(1);
    expect(report.details.find((d) => d.binId === binId)?.disposition).toBe('CLOSED_WITH_PACKET');
    const events = await listBinEvents(binId);
    expect(events.some((e) => e.eventType === 'BIN_TERMINAL' && e.outcome === 'CANCELLED')).toBe(true);
    // A second pass finds nothing to do.
    const again = await reconcileBins(projectId);
    expect(again.details.find((d) => d.binId === binId)).toBeUndefined();
  });

  it('leaves a FAILED packet\'s bin for a person', async () => {
    const { binId } = await parkedBinUnder('FAILED');
    await reconcileBins(projectId);
    expect((await getBin(binId))?.state).toBe('NEEDS_HUMAN');
  });
});
