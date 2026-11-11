/**
 * GOV-22-2 on the production path: a prepared option is recorded through the
 * terminal entrance, a live goal's capability assessment that is blocked on it
 * is found by the pass the Russell tick runs (`advancePreparedOptions`, called
 * from `advanceSources`), the minimum permitted method is handed to the Factory
 * contract once, and the goal's waiting work is judged resumed from rows.
 *
 * Only the Factory submission is substituted (it reads the forge); everything
 * else is the real rows the running Brain writes.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { recordEvent, listEvents } from '../server/repos/events.ts';
import { createWorkstream } from '../server/repos/register.ts';
import { enqueueWork } from '../server/repos/workQueue.ts';
import {
  PREPARED_HANDOFF_KIND,
  PREPARED_NEEDED_KIND,
  PREPARED_OPTION_KIND,
  PREPARED_RESUMED_KIND,
  advancePreparedOptions,
  type SubmitNeed,
} from '../server/services/capability/prepared.ts';
import { runPreparedCommand } from '../server/services/capability/preparedCommand.ts';

const option = (requirementId: string, methods: unknown[]) =>
  JSON.stringify({
    requirementId,
    feasibility: { verdict: 'FEASIBLE', note: 'an open-source reader exists' },
    methods,
    interfaceSketch: { text: 'read(url) -> text', tested: true },
  });

describe('a prepared option reaches the Factory from production rows (GOV-22-2)', () => {
  let projectId: string;
  let submitted: Parameters<SubmitNeed>[0][];
  const submit: SubmitNeed = async (input) => {
    submitted.push(input);
    return { changeRequestId: `fcr_${submitted.length}`, created: true };
  };

  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
    submitted = [];
  });

  async function goalBlockedOn(...requirementIds: string[]): Promise<string> {
    const goal = await createWorkstream({ projectId, title: 'goal', intent: 'earn from documents nobody can read', purpose: 'REVENUE_DIRECT', createdByUserId: null });
    await recordEvent({
      projectId,
      entityType: 'WORKSTREAM',
      entityId: goal.id,
      eventType: 'CAPABILITY_ASSESSED',
      payload: { maps: ['RESEARCH'], ready: false, blocking: requirementIds.map((id) => `MISSING:${id}`), cleared: [] },
    });
    return goal.id;
  }

  it('records through the terminal entrance as an event that is never an integration', async () => {
    const lines = await runPreparedCommand(['record', projectId, 'opt.json'], {
      read: async () => option('read-scanned', [{ name: 'ocr-tool', kind: 'OPEN_SOURCE_TOOL', gates: [], effort: 2, sources: ['https://example.test/ocr'] }]),
    });
    expect(lines.join('\n')).toContain('integration: false');
    const events = (await listEvents(projectId, 50)).filter((e) => e.payload.kind === PREPARED_OPTION_KIND);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.integration).toBe(false);
  });

  it('nothing is handed off while no live goal needs the option', async () => {
    await runPreparedCommand(['record', projectId, 'opt.json'], {
      read: async () => option('read-scanned', [{ name: 'ocr-tool', kind: 'OPEN_SOURCE_TOOL', gates: [], effort: 2, sources: [] }]),
    });
    const r = await advancePreparedOptions({ submit });
    expect(r.needs.handedOff).toBe(0);
    expect(submitted).toHaveLength(0);
  });

  it('a goal blocked on the requirement is handed to the Factory once, with the cheapest permitted method, and its work resumes', async () => {
    await runPreparedCommand(['record', projectId, 'opt.json'], {
      read: async () =>
        option('read-scanned', [
          { name: 'browser-robot', kind: 'NO_API', gates: [], effort: 5, sources: [] },
          { name: 'ocr-tool', kind: 'OPEN_SOURCE_TOOL', gates: [], effort: 2, sources: [] },
          { name: 'paid-ocr', kind: 'API', gates: ['SPEND'], effort: 1, sources: [] },
        ]),
    });
    const waiting = await enqueueWork({ projectId, workType: 'RESEARCH_FRAGMENT', createdByType: 'SYSTEM' });
    const goalId = await goalBlockedOn('read-scanned', 'unprepared-requirement');

    const first = await advancePreparedOptions({ submit });
    expect(first.needs).toMatchObject({ goals: 1, handedOff: 1, gated: 0, refused: [] });
    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.objective).toContain('ocr-tool');
    expect(submitted[0]!.objective).toContain(goalId);
    const handoffs = (await listEvents(projectId, 100)).filter((e) => e.payload.kind === PREPARED_HANDOFF_KIND);
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]!.payload).toMatchObject({ integration: false, goalId, method: 'ocr-tool', blockedWorkItemIds: [waiting.id] });

    // The next pass does not hand it off again, and the work has not run yet.
    const second = await advancePreparedOptions({ submit });
    expect(second.needs.handedOff).toBe(0);
    expect(submitted).toHaveLength(1);
    expect(second.resumed).toBe(0);

    // The waiting work completes after the handoff: the tick records it resumed, once.
    const later = new Date(Date.now() + 60_000).toISOString();
    await getDb().run(`UPDATE work_items SET state = 'SUCCEEDED', completed_at = ? WHERE id = ?`, [later, waiting.id]);
    const third = await advancePreparedOptions({ submit });
    expect(third.resumed).toBe(1);
    const fourth = await advancePreparedOptions({ submit });
    expect(fourth.resumed).toBe(0);
    expect((await listEvents(projectId, 200)).filter((e) => e.payload.kind === PREPARED_RESUMED_KIND)).toHaveLength(1);
  });

  it('when every method is gated it records the gates for a person and hands nothing over', async () => {
    await runPreparedCommand(['record', projectId, 'opt.json'], {
      read: async () => option('read-scanned', [{ name: 'paid-ocr', kind: 'API', gates: ['SPEND', 'CREDENTIALS'], effort: 1, sources: [] }]),
    });
    await goalBlockedOn('read-scanned');
    const r = await advancePreparedOptions({ submit });
    expect(r.needs).toMatchObject({ handedOff: 0, gated: 1 });
    expect(submitted).toHaveLength(0);
    const needed = (await listEvents(projectId, 100)).filter((e) => e.payload.kind === PREPARED_NEEDED_KIND);
    expect(needed).toHaveLength(1);
    expect(needed[0]!.payload.needsPerson).toEqual(['SPEND', 'CREDENTIALS']);
    expect((await advancePreparedOptions({ submit })).needs.gated).toBe(0);
  });

  it('a refused submission is reported and retried on the next pass, not recorded as a handoff', async () => {
    await runPreparedCommand(['record', projectId, 'opt.json'], {
      read: async () => option('read-scanned', [{ name: 'ocr-tool', kind: 'OPEN_SOURCE_TOOL', gates: [], effort: 2, sources: [] }]),
    });
    await goalBlockedOn('read-scanned');
    const refusing: SubmitNeed = async () => {
      throw new Error('forge unreachable');
    };
    const r = await advancePreparedOptions({ submit: refusing });
    expect(r.needs.refused[0]).toContain('forge unreachable');
    expect((await listEvents(projectId, 100)).filter((e) => e.payload.kind === PREPARED_HANDOFF_KIND)).toHaveLength(0);
    expect((await advancePreparedOptions({ submit })).needs.handedOff).toBe(1);
  });

  it('an archived goal is not acted on', async () => {
    await runPreparedCommand(['record', projectId, 'opt.json'], {
      read: async () => option('read-scanned', [{ name: 'ocr-tool', kind: 'OPEN_SOURCE_TOOL', gates: [], effort: 2, sources: [] }]),
    });
    const goalId = await goalBlockedOn('read-scanned');
    await getDb().run(`UPDATE workstreams SET archived_at = ?, archived_reason = ? WHERE id = ?`, [new Date().toISOString(), 'done', goalId]);
    expect((await advancePreparedOptions({ submit })).needs).toMatchObject({ goals: 0, handedOff: 0 });
  });
});
