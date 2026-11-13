/**
 * TEL-07-1 (S-0083): "Current implementation must read fresh production
 * telemetry before deciding to upgrade CPU, memory, GPU or model capacity."
 * The gate refuses an upgrade on a stale, undated or unreadable reading, and
 * the discovery grant's concurrency raise — a capacity path — goes through it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import {
  CAPACITY_DECIDING_MEASURES,
  CAPACITY_READING_MAX_AGE_MS,
  capacityChangeGate,
  forgetTelemetryReading,
  rollingTelemetry,
} from '../server/services/cash/screenMetrics.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { DISCOVERY_CONCURRENCY, discoveryAuthority, ensureDiscoveryAuthority } from '../server/services/cash/discoveryAuthority.ts';
import { setGoalConcurrency } from '../server/repos/russellAuthority.ts';
import { cashEventsOfKindInProject } from '../server/repos/cashMode.ts';

let projectId = '';

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  forgetTelemetryReading();
});

describe('capacity changes read fresh telemetry first (TEL-07-1)', () => {
  it('refuses a machine upgrade on a reading older than the freshness bound', async () => {
    const now = new Date('2026-11-10T12:00:00.000Z');
    const old = await rollingTelemetry(new Date(now.getTime() - CAPACITY_READING_MAX_AGE_MS - 1));
    for (const resource of ['CPU', 'MEMORY', 'GPU', 'MODEL'] as const) {
      const decision = await capacityChangeGate({ resource, direction: 'INCREASE', reason: 'test' }, { now, reading: old });
      expect(decision.allowed).toBe(false);
      expect(decision.code).toBe('STALE_READING');
      expect(decision.readingAt).toBe(old.at);
    }
  });

  it('refuses a reading dated in the future', async () => {
    const now = new Date('2026-11-10T12:00:00.000Z');
    const future = await rollingTelemetry(new Date(now.getTime() + 60_000));
    const decision = await capacityChangeGate({ resource: 'GPU', direction: 'INCREASE', reason: 'test' }, { now, reading: future });
    expect(decision.code).toBe('STALE_READING');
  });

  it('reads its own reading when handed none, and carries every deciding figure in every window', async () => {
    const now = new Date();
    const decision = await capacityChangeGate({ resource: 'CONCURRENCY', direction: 'INCREASE', from: 6, to: 8, reason: 'test' }, { now });
    expect(decision.readingAt).not.toBeNull();
    expect(decision.readingAgeMs).toBeLessThanOrEqual(CAPACITY_READING_MAX_AGE_MS);
    expect(decision.allowed).toBe(true);
    expect(decision.code).toBe('FRESH_READING');
    expect(new Set(decision.figures.map((f) => f.measure))).toEqual(new Set(CAPACITY_DECIDING_MEASURES));
    expect(decision.figures).toHaveLength(CAPACITY_DECIDING_MEASURES.length * 3);
  });

  it('refuses when a deciding measure cannot be read, never treating unknown as favourable', async () => {
    const db = getDb();
    await db.run('ALTER TABLE quota_pauses RENAME TO quota_pauses_hidden', []);
    try {
      const now = new Date('2026-11-10T12:00:00.000Z');
      const reading = await rollingTelemetry(now);
      const decision = await capacityChangeGate({ resource: 'CONCURRENCY', direction: 'INCREASE', reason: 'test' }, { now, reading });
      expect(decision.allowed).toBe(false);
      expect(decision.code).toBe('UNREADABLE_TELEMETRY');
      expect(decision.reason).toMatch(/providerQuota/);
    } finally {
      await db.run('ALTER TABLE quota_pauses_hidden RENAME TO quota_pauses', []);
    }
  });

  it('refuses a machine upgrade when the fresh reading shows nothing waiting', async () => {
    const now = new Date('2026-11-10T12:00:00.000Z');
    const reading = await rollingTelemetry(now);
    const decision = await capacityChangeGate({ resource: 'GPU', direction: 'INCREASE', reason: 'test' }, { now, reading });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('NOTHING_WAITING');
  });

  it('does not gate a decrease, which is not an upgrade', async () => {
    const decision = await capacityChangeGate({ resource: 'GPU', direction: 'DECREASE', reason: 'test' });
    expect(decision).toMatchObject({ allowed: true, code: 'NOT_AN_UPGRADE' });
  });

  it('raises the discovery grant\'s concurrency only on a fresh, readable reading, and records which reading', async () => {
    const user = await createUser({ email: `cap-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' });
    await activate({ projectId, ownerUserId: user.id, actorUserId: user.id, objective: 'Maximize additional usable cash over the next few weeks.' });
    const goal = (await discoveryAuthority(projectId))!;
    await setGoalConcurrency(goal.id, 2);

    const db = getDb();
    await db.run('ALTER TABLE quota_pauses RENAME TO quota_pauses_hidden', []);
    try {
      forgetTelemetryReading();
      await ensureDiscoveryAuthority(projectId);
      expect((await discoveryAuthority(projectId))!.maxConcurrent).toBe(2);
    } finally {
      await db.run('ALTER TABLE quota_pauses_hidden RENAME TO quota_pauses', []);
    }

    forgetTelemetryReading();
    await ensureDiscoveryAuthority(projectId);
    expect((await discoveryAuthority(projectId))!.maxConcurrent).toBe(DISCOVERY_CONCURRENCY);
    const raised = (await cashEventsOfKindInProject(projectId, 'CASH_DISCOVERY_AUTHORIZED')).find(
      (event) => (event.detail as { to?: number } | null)?.to === DISCOVERY_CONCURRENCY && (event.detail as { from?: number }).from === 2,
    );
    expect(raised).toBeDefined();
    expect((raised!.detail as { capacityGate?: string }).capacityGate).toBe('FRESH_READING');
    expect(typeof (raised!.detail as { telemetryReadingAt?: string }).telemetryReadingAt).toBe('string');
  });
});
