/**
 * CAP-19-5 / CAP-21-7 / CAP-25-2 wiring — the free lane's existing hourly
 * stage-capacity tick also records CAPACITY_CONTRIBUTION, ACQUISITION_MEASURES
 * and STAGE_LIMIT, each isolated, and the report CLI prints all three. No new
 * timer, scheduler or table. Over real database rows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import {
  CAPACITY_FOLLOWER_EVENTS,
  STAGE_CAPACITY_EVENT,
  defaultCapacityFollowers,
  recordStageCapacity,
  runCapacityFollowers,
  type CapacityFollower,
} from '../server/services/freeLane/stageCapacity.ts';
import { capacityFollowerLines, readCapacityFollowers, stageCapacityReport } from '../server/services/freeLane/stageCapacityReport.ts';
import { CAPACITY_CONTRIBUTION_EVENT } from '../server/services/freeLane/contribution.ts';
import { STAGE_LIMIT_EVENT } from '../server/services/freeLane/stageLimit.ts';
import { ACQUISITION_MEASURES_EVENT } from '../server/services/feeds/acquisitionMeasures.ts';

beforeEach(async () => {
  await freshProject();
});

async function rows(eventType: string): Promise<{ outcome: string; reason: string | null }[]> {
  return getDb().all(`SELECT outcome, reason FROM bin_events WHERE event_type = ? ORDER BY at, id`, [eventType]);
}

describe('the hourly stage-capacity tick records the three readings', () => {
  it('names each owner’s own event', () => {
    expect([...CAPACITY_FOLLOWER_EVENTS]).toEqual([CAPACITY_CONTRIBUTION_EVENT, ACQUISITION_MEASURES_EVENT, STAGE_LIMIT_EVENT]);
    expect(defaultCapacityFollowers().map((f) => f.event)).toEqual([...CAPACITY_FOLLOWER_EVENTS]);
  });

  it('one tick writes the stage-capacity row and all three new bin events, with the real readers', async () => {
    await recordStageCapacity({ hours: 1 });
    expect(await rows(STAGE_CAPACITY_EVENT)).toHaveLength(1);
    for (const event of CAPACITY_FOLLOWER_EVENTS) {
      const written = await rows(event);
      expect(written, event).toHaveLength(1);
      expect(written[0]!.outcome, event).not.toBe('NOT_MEASURED');
    }
  });

  it('a reader that fails is logged and recorded as NOT_MEASURED, and neither the others nor the stage-capacity row are lost', async () => {
    const ran: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const followers: CapacityFollower[] = [
      { event: CAPACITY_CONTRIBUTION_EVENT, run: async () => { throw new Error('contribution reader exploded'); } },
      { event: ACQUISITION_MEASURES_EVENT, run: async () => { ran.push('acquisition'); } },
      { event: STAGE_LIMIT_EVENT, run: async () => { ran.push('limit'); } },
    ];
    const report = await recordStageCapacity({ hours: 1, followers });
    expect(report).not.toBeNull();
    expect(await rows(STAGE_CAPACITY_EVENT)).toHaveLength(1);
    expect(ran).toEqual(['acquisition', 'limit']);
    const failed = await rows(CAPACITY_CONTRIBUTION_EVENT);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.outcome).toBe('NOT_MEASURED');
    expect(failed[0]!.reason).toContain('contribution reader exploded');
    expect(warn.mock.calls.some((c) => String(c[0]).includes('contribution reader exploded'))).toBe(true);
    warn.mockRestore();
  });

  it('runCapacityFollowers never throws and reports each outcome', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const out = await runCapacityFollowers(new Date(), [
      { event: STAGE_LIMIT_EVENT, run: async () => { throw new Error('limit down'); } },
      { event: ACQUISITION_MEASURES_EVENT, run: async () => undefined },
    ]);
    expect(out).toEqual([
      { event: STAGE_LIMIT_EVENT, ok: false, error: 'limit down' },
      { event: ACQUISITION_MEASURES_EVENT, ok: true, error: null },
    ]);
    warn.mockRestore();
  });
});

describe('the report CLI prints the three readings', () => {
  it('says each is not recorded yet before the first tick', async () => {
    const lines = capacityFollowerLines(await readCapacityFollowers());
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line).toContain('not recorded yet');
  });

  it('prints the latest of each after a tick, in text and JSON', async () => {
    await recordStageCapacity({ hours: 1 });
    const text = await stageCapacityReport([]);
    expect(text).toContain('stage capacity');
    for (const event of CAPACITY_FOLLOWER_EVENTS) {
      const line = text.split('\n').find((l) => l.startsWith(event.toLowerCase()));
      expect(line, event).toBeTruthy();
      expect(line, event).not.toContain('not recorded yet');
    }
    const json = JSON.parse(await stageCapacityReport(['--json'])) as { at: string; followers: { event: string; at: string | null }[] };
    expect(typeof json.at).toBe('string');
    expect(json.followers.map((f) => f.event)).toEqual([...CAPACITY_FOLLOWER_EVENTS]);
    for (const f of json.followers) expect(f.at).not.toBeNull();
  });
});
