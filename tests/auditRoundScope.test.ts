import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { listLayers } from '../server/repos/layers.ts';
import { createRun } from '../server/repos/runs.ts';
import { createOrchestration } from '../server/repos/research.ts';
import { createProject } from '../server/repos/projects.ts';
import { recordEvent } from '../server/repos/events.ts';
import { auditRoundFor } from '../server/services/research/auditRound.ts';

/*
 * Deploy 345, 09:26:55Z and 09:38:57Z: `could not resume packet … canceling
 * statement due to statement timeout` in `SELECT created_at, payload FROM
 * project_events WHERE event_type IN (…) ORDER BY created_at DESC LIMIT 50`.
 *
 * The statement scanned every project's events, and the timeout is the visible
 * half. The quieter half is correctness: the fifty newest round events *in the
 * Brain* were filtered to one orchestration afterwards, so a packet whose
 * boundary was older than fifty other round events anywhere read as having no
 * round at all — and every audit pass since its reopen counted as current.
 */
let projectId = '';
let layerId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layerId = (await listLayers(projectId))[0]!.id;
});

async function orchestration(): Promise<string> {
  const run = await createRun({
    projectId, layerId, runType: 'FOUNDATION', status: 'PLANNED', provider: 'WORKER', prompt: 'q',
  });
  return (await createOrchestration({
    projectId, layerId, runId: run.id, title: 'q', assignment: 'a', provider: 'WORKER', autoApprove: false,
  })).id;
}

describe('the current audit round', () => {
  it('is found however many rounds began elsewhere since', async () => {
    const mine = await orchestration();
    await recordEvent({
      projectId, layerId, entityType: 'DOCUMENT', entityId: null,
      eventType: 'AUDIT_ROUND_REOPENED',
      payload: { orchestrationId: mine, roundStartedAt: '2026-09-24T09:00:00.000Z', rolesCarried: [{ role: 'PRIMARY' }] },
    });
    const elsewhere = await createProject({ name: 'Elsewhere', slug: 'elsewhere' });
    for (let i = 0; i < 60; i++) {
      await recordEvent({
        projectId: elsewhere.id, entityType: 'DOCUMENT', entityId: null,
        eventType: 'DOCUMENT_HANDED_OFF', payload: { orchestrationId: `orc_other_${i}` },
      });
    }
    const round = await auditRoundFor(mine);
    expect(round.since).toBe('2026-09-24T09:00:00.000Z');
    expect([...round.carried]).toEqual([5]);
  });

  it('still reads nothing for a packet that never had one', async () => {
    const mine = await orchestration();
    expect((await auditRoundFor(mine)).since).toBeNull();
  });
});
