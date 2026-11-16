/**
 * Review finding repair-F2-2 (FALL-37-4, FALL-37-6): live promotion in the
 * preparation ranking could never fire, because the ranking reads failures
 * under the acquisition key (`acquisition:<projectId>`) and the only
 * production writer of failure records (the forecast watch) writes them under
 * a forecast claim id. The acquisition dependency's own failures are now
 * recorded under its own key, from its primary path's ordered contact results,
 * on the same refresh that ranks it (`fallbackPreparation.ts`
 * `prepareProjectFallbacks` → `fallbackPlanReading.ts recordAcquisitionFailures`).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { keepCashLedger, readFailureRecoveries } from '../server/services/quant/ledger.ts';
import { readFallbackPreparation } from '../server/services/quant/fallbackPreparation.ts';
import { acquisitionFailures } from '../server/services/quant/fallbackPlanReading.ts';

const r = (id: string, result: string, day: number) => ({ id, result, at: new Date(Date.UTC(2026, 9, 1 + day)).toISOString() });

describe('acquisitionFailures: a failure is read from the path\'s own record', () => {
  it('pure: a run improbable under the path\'s own record is a failure; recovery is the next good result, unknown while the run is latest', () => {
    const delivered = Array.from({ length: 10 }, (_, i) => r(`d${i}`, 'BUYER_REPLIED', i));
    const ongoing = acquisitionFailures('acquisition:p', 'A @ email', [...delivered, r('u1', 'CONTACT_UNDELIVERABLE', 10), r('u2', 'CONTACT_UNDELIVERABLE', 12)]);
    expect(ongoing).toEqual([
      expect.objectContaining({
        occurrence: 'acquisition-failure:acquisition:p:A @ email:channel-stops-delivering:u1',
        dependency: 'acquisition:p',
        failureMode: 'channel-stops-delivering',
        failureClass: 'ACQUISITION:channel-stops-delivering',
        detectionDelayDays: 2,
        recovered: null,
        timeToHarmDays: null,
        tried: [],
      }),
    ]);
    const recovered = acquisitionFailures('acquisition:p', 'A @ email', [...delivered, r('u1', 'CONTACT_UNDELIVERABLE', 10), r('u2', 'CONTACT_UNDELIVERABLE', 11), r('d10', 'BUYER_REPLIED', 12)]);
    expect(recovered.map((f) => [f.failureMode, f.recovered])).toEqual([['channel-stops-delivering', true]]);
  });

  it('pure: noise is not failure, a path that never succeeded did not stop, and silence is judged over delivered results only', () => {
    const delivered = Array.from({ length: 10 }, (_, i) => r(`d${i}`, 'BUYER_REPLIED', i));
    expect(acquisitionFailures('k', 'A', [...delivered, r('u1', 'CONTACT_UNDELIVERABLE', 10)])).toEqual([]);
    expect(acquisitionFailures('k', 'A', Array.from({ length: 6 }, (_, i) => r(`u${i}`, 'CONTACT_UNDELIVERABLE', i)))).toEqual([]);
    const silent = acquisitionFailures('k', 'A', [
      ...Array.from({ length: 4 }, (_, i) => r(`a${i}`, 'BUYER_REPLIED', i)),
      r('s1', 'BUYER_SILENT', 4), r('x', 'CONTACT_UNDELIVERABLE', 5), r('s2', 'BUYER_SILENT', 6), r('s3', 'BUYER_SILENT', 7),
    ]);
    expect(silent.map((f) => [f.failureMode, f.occurrence.endsWith(':s1'), f.recovered])).toEqual([['prospects-stop-answering', true, null]]);
  });

});

describe('on production rows: the acquisition dependency records its own failures, and a live one promotes its safeguards', () => {
  let projectId: string;
  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
  });

  async function row(mechanism: string, channel: string, i: number, result: string, day: number): Promise<void> {
    await getDb().run(
      `INSERT INTO cash_outcomes (id, project_id, opportunity_id, kind, mechanism, channel, value_text, basis, request_key, created_at)
       VALUES (?, ?, ?, 'CONTACT_RESULT', ?, ?, ?, 'test row', ?, ?)`,
      [`cou_${mechanism}_${i}_${projectId}`.replace(/\W/g, '_'), projectId, `lead:${mechanism}:${i}`, mechanism, channel, result, `r:${mechanism}:${i}`, new Date(Date.UTC(2026, 9, 1 + day)).toISOString()],
    );
  }

  it('runs on the production path with nothing injected: the channel stopping promotes its safeguard, and its recovery settles it', async () => {
    for (let i = 0; i < 8; i++) await row('Campaign A', 'email (Instantly)', i, 'BUYER_REPLIED', i);
    await row('Partner list', 'partner referral', 0, 'BUYER_REPLIED', 0);
    for (let i = 8; i < 11; i++) await row('Campaign A', 'email (Instantly)', i, 'CONTACT_UNDELIVERABLE', i);

    await keepCashLedger(projectId, []);
    const failures = await readFailureRecoveries(projectId);
    expect(failures).toEqual([
      expect.objectContaining({ dependency: `acquisition:${projectId}`, failureMode: 'channel-stops-delivering', recovered: null }),
    ]);
    const live = await readFallbackPreparation(projectId);
    expect(live!.ranked[0]).toMatchObject({ substitute: 'Partner list @ partner referral', decidedBy: 'LIVE_DEPENDENCY', promoted: true });
    expect(live!.ranked[0]!.promotedBecause).toMatch(/channel-stops-delivering\) is on the ledger and recovery is not yet known/);

    await row('Campaign A', 'email (Instantly)', 11, 'BUYER_REPLIED', 11);
    await keepCashLedger(projectId, []);
    expect((await readFailureRecoveries(projectId)).map((f) => f.recovered)).toEqual([true]);
    expect((await readFallbackPreparation(projectId))!.ranked[0]).toMatchObject({ promoted: false });
  });
});
