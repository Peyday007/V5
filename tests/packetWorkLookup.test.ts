/**
 * A packet's work is read by the packet, never filtered out of a project window.
 *
 * Production, Cash Mode 1, 2026-10-08: `orc_381e9bb31d4f49ecb7cc` was
 * RESEARCHING with its one fragment QUEUED, and `packet-report` printed
 * "WORK ITEMS (0)". The runner and the report both read the project's first
 * 500 / 400 work items — ordered by priority, then age — and filtered that page
 * down to the packet. A project with more work than the page holds therefore
 * made a packet's own work invisible, and because `enqueueResearchItem` is
 * idempotent only through the runner's `alreadyCreated` check, every advance of
 * such a packet inserted the same research item again.
 *
 * The fixture reproduces that shape exactly: more than five hundred items in
 * one project, the packet's item sorted outside the old page.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { freshProject } from './helpers.ts';
import { createRun } from '../server/repos/runs.ts';
import { createFragments, createOrchestration } from '../server/repos/research.ts';
import {
  enqueueWork,
  listWorkItems,
  listWorkItemsForOrchestration,
} from '../server/repos/workQueue.ts';
import { workType } from '../server/services/queue/workTypes.ts';
import { advancePacket, resumePulledPackets } from '../server/services/research/packetRunner.ts';
import type { Layer, Project, ResearchOrchestration } from '../server/domain/types.ts';

let project: Project;
let layer: Layer;

beforeEach(async () => {
  const fixture = await freshProject();
  project = fixture.project;
  layer = await fixture.layerByName('Monetization Logic');
});

async function researchingPacket(): Promise<ResearchOrchestration> {
  const run = await createRun({
    projectId: project.id,
    layerId: layer.id,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: 'Who pays for this?',
  });
  const orchestration = await createOrchestration({
    projectId: project.id,
    layerId: layer.id,
    runId: run.id,
    title: 'Qualify an opening in a busy project',
    assignment: 'Who pays for this?',
    provider: 'WORKER',
    autoApprove: false,
  });
  await createFragments([
    {
      orchestrationId: orchestration.id,
      projectId: project.id,
      layerId: layer.id,
      fragmentIndex: 0,
      fragmentKey: 'opening-validation',
      question: 'Who pays for this, according to a published source?',
      geography: 'United States',
      timeframe: 'as at 2026',
      population: null,
      definitions: null,
      requiredEvidence: [{ id: 'payer', description: 'a named payer', necessity: 'REQUIRED' }],
      acceptableSourceTypes: ['the published request'],
      excludedSourceTypes: ['blog'],
      completionCriteria: ['A named payer, or a documented absence of one.'],
      dependsOn: [],
      minIndependentSources: 1,
      status: 'QUEUED',
    },
  ]);
  return orchestration;
}

/** More work than the old page held, all of it sorted ahead of a packet's. */
async function crowdTheProject(count: number): Promise<void> {
  const echo = workType('SYNTHETIC_ECHO');
  for (let index = 0; index < count; index += 1) {
    await enqueueWork({
      projectId: project.id,
      workType: 'SYNTHETIC_ECHO',
      payload: echo.validate({ note: `filler ${index}` }),
      requiredScopes: echo.requiredScopes,
      priority: 9,
      createdByType: 'SYSTEM',
    });
  }
}

async function researchItems(orchestrationId: string) {
  return (await listWorkItemsForOrchestration(orchestrationId)).filter(
    (item) => item.workType === 'RESEARCH_FRAGMENT',
  );
}

describe('a packet in a project with more work than one page', () => {
  it('sees its own work, enqueues it once, and converges across restart and concurrent ticks', async () => {
    const packet = await researchingPacket();
    const first = await advancePacket(packet.id);
    expect(first.enqueued.map((entry) => entry.workType)).toEqual(['RESEARCH_FRAGMENT']);
    const [original] = await researchItems(packet.id);
    expect(original?.state).toBe('QUEUED');

    await crowdTheProject(520);

    // The precondition, asserted rather than assumed: the old window does not
    // contain this packet's work at all.
    const page = await listWorkItems(project.id, { limit: 500 });
    expect(page).toHaveLength(500);
    expect(page.some((item) => item.orchestrationId === packet.id)).toBe(false);

    // The packet-scoped read is independent of the project's size.
    expect((await listWorkItemsForOrchestration(packet.id)).map((item) => item.id)).toEqual([
      original!.id,
    ]);

    // The runner sees it: another advance is waiting on that item, not making a second.
    const again = await advancePacket(packet.id);
    expect(again.enqueued).toEqual([]);

    // Concurrent ticks converge on the same single item.
    const racing = await Promise.all([advancePacket(packet.id), advancePacket(packet.id)]);
    expect(racing.flatMap((result) => result.enqueued)).toEqual([]);

    // A restart's resume recognises the packet as worker-driven — it used to
    // decide that from the same window — and creates nothing new either.
    await resumePulledPackets();

    const after = await researchItems(packet.id);
    expect(after.map((item) => item.id)).toEqual([original!.id]);
    expect(after[0]?.state).toBe('QUEUED');
  });

  it('reads every item of a packet, however many it has, in priority order', async () => {
    const packet = await researchingPacket();
    const echo = workType('SYNTHETIC_ECHO');
    for (let index = 0; index < 505; index += 1) {
      await enqueueWork({
        projectId: project.id,
        workType: 'SYNTHETIC_ECHO',
        payload: echo.validate({ note: `packet ${index}` }),
        requiredScopes: echo.requiredScopes,
        priority: index === 504 ? 9 : 5,
        orchestrationId: packet.id,
        createdByType: 'SYSTEM',
      });
    }
    const items = await listWorkItemsForOrchestration(packet.id);
    expect(items).toHaveLength(505);
    expect(items[0]?.priority).toBe(9);
  });
});

describe('no packet-scoped reader filters a project-wide window', () => {
  /**
   * The behaviour above is pinned for the runner. The report and the other
   * packet-scoped readers are guarded by reading them, for
   * `operatorConsoleRemoved`'s reason: what must not exist is a pattern, and
   * the pattern is a project page filtered down to one orchestration.
   */
  const READERS = [
    'server/services/research/packetRunner.ts',
    'server/services/research/reissue.ts',
    'server/services/research/synthesisRecovery.ts',
    'server/services/russell/loop.ts',
    'scripts/packet-report.ts',
    'scripts/verify-research-capability.ts',
  ];

  it('reads a packet’s work by orchestration in every one of them', () => {
    for (const path of READERS) {
      const source = readFileSync(path, 'utf8');
      // A project page whose result is then narrowed to one orchestration.
      const windowed =
        /listWorkItems\([^)]*\)[\s\S]{0,200}?orchestrationId\s*(===|!==)/.exec(source);
      expect(windowed?.[0] ?? null, path).toBeNull();
    }
    expect(readFileSync('scripts/packet-report.ts', 'utf8')).toContain(
      'listWorkItemsForOrchestration(packet.id)',
    );
  });
});
