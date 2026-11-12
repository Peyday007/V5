/**
 * A REVISE decision revises the method; it never closes the bucket (F3-4).
 *
 * A bucket whose last rounds mostly re-reported openings already held
 * (FALSE_POSITIVE_SHARE), or that has gone stale, used to be gated shut with
 * no new version, no event and no retry time: retirement by another name.
 * These walk the production entry points against a real database: the closed
 * round that completes the streak writes version 2 with a revision
 * instruction, retires version 1 with the reason, records a cash event, the
 * bucket stays open, `openDiscovery` asks its next round with the instruction
 * in the question, and a bucket revised MAX_REVISIONS times waits with a
 * retry time rather than being revised again or closed for good.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { listMethodRuns, listSearchMethods } from '../server/repos/searchMethods.ts';
import { listCashEvents } from '../server/repos/cashMode.ts';
import { getCandidate } from '../server/repos/russellCandidates.ts';
import {
  MAX_REVISIONS,
  bucketGates,
  methodForBucket,
  readerForProject,
  recordRoundAsRun,
  revisionInstruction,
  type RoundEnding,
} from '../server/services/research/searchMethods/bucketMethods.ts';
import { recordRunAndSettle } from '../server/services/research/searchMethods/lifecycle.ts';
import { FAILURE_STREAK, MAX_RETRY_MS } from '../server/services/research/searchFailures/classify.ts';
import { SEARCH_BUCKETS, openDiscovery } from '../server/services/cash/discovery.ts';
import { activate } from '../server/services/cash/lifecycle.ts';

let projectId = '';
let userId = '';

beforeEach(async () => {
  projectId = (await freshProject()).project.id;
  userId = (await createUser({
    email: `revise-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner', password: 'correct horse battery staple',
  })).id;
});

const DUPLICATES: RoundEnding = { to: 'HARVESTED', missionState: 'DONE', found: 4, useful: 0, duplicates: 3 };

async function versions(bucketId: string) {
  return (await listSearchMethods(readerForProject(projectId)))
    .filter((m) => m.methodKey === bucketId)
    .sort((a, b) => a.version - b.version);
}

describe('a method flagged for revision is revised, not closed', () => {
  it('writes the next version, retires the old one with its reason, records an event and keeps the bucket open', async () => {
    const bucket = SEARCH_BUCKETS[0]!;
    let last = null as Awaited<ReturnType<typeof recordRoundAsRun>>;
    for (let i = 0; i < FAILURE_STREAK; i += 1) last = await recordRoundAsRun(projectId, bucket, DUPLICATES);

    expect(last?.revision).toMatchObject({ cause: 'HIGH_FALSE_POSITIVES' });
    expect(last?.decision.action).toBe('RUN');
    const [v1, v2] = await versions(bucket.id);
    expect(v1).toMatchObject({ version: 1, trustState: 'RETIRED' });
    expect(v1!.trustReason).toContain('superseded by version 2 (HIGH_FALSE_POSITIVES)');
    expect(v2).toMatchObject({ version: 2, trustState: 'PROPOSED' });
    expect(v2!.limits).toContain('9 of the 12 filed were duplicates');
    expect(v2!.checkProcedure).toContain('Revised:');

    const events = (await listCashEvents(projectId, 50)).filter((e) => e.kind === 'CASH_DISCOVERY_METHOD_REVISED');
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toMatchObject({ bucketId: bucket.id, fromVersion: 1, toVersion: 2, cause: 'HIGH_FALSE_POSITIVES' });

    const gate = (await bucketGates(projectId, [bucket.id], new Date().toISOString())).get(bucket.id)!;
    expect(gate.mayOpen).toBe(true);
    // A revised method has no code executor, so a Claude development round asks it.
    expect(gate.route).toBe('DEVELOP');
    expect(gate.revision).toBe(v2!.limits);

    // The next round's runs belong to the revised version, and start a fresh streak.
    await recordRoundAsRun(projectId, bucket, { to: 'HARVESTED', missionState: 'DONE', found: 2, useful: 1, duplicates: 0 });
    expect(await listMethodRuns(readerForProject(projectId), v2!.id)).toHaveLength(1);
    expect(await listMethodRuns(readerForProject(projectId), v1!.id)).toHaveLength(FAILURE_STREAK);
  });

  it('asks the revised bucket\'s next round with the revision in its question', async () => {
    const outcome = await activate({ projectId, ownerUserId: userId, actorUserId: userId, objective: 'Maximize additional usable cash.' });
    expect(outcome.ok).toBe(true);
    const bucket = SEARCH_BUCKETS[0]!;
    for (let i = 0; i < FAILURE_STREAK; i += 1) await recordRoundAsRun(projectId, bucket, DUPLICATES);
    const opened = await openDiscovery({ projectId, limit: SEARCH_BUCKETS.length + 50 });
    const mine = opened.find((o) => o.bucketId === bucket.id);
    expect(mine).toBeDefined();
    const candidate = await getCandidate(mine!.candidateId);
    expect(candidate?.statement).toContain('mostly re-reported openings Brain already held');
  });

  it('acts on a REVISE already on record when the gate reads it, so no bucket stays shut', async () => {
    // A method that reached REVISE before its consumer existed: its runs were written without
    // `recordRoundAsRun`, so only the gate can act on it.
    const bucket = SEARCH_BUCKETS[1]!;
    const v1 = await methodForBucket(projectId, bucket);
    for (let i = 0; i < FAILURE_STREAK; i += 1) {
      await recordRunAndSettle(readerForProject(projectId), { methodId: v1.id, executor: 'CLAUDE', outcome: 'FALSE_POSITIVES', surfaced: 4, rejected: 3, examined: 4 });
    }
    expect((await versions(bucket.id)).map((m) => m.version)).toEqual([1]);
    const gate = (await bucketGates(projectId, [bucket.id], new Date().toISOString())).get(bucket.id)!;
    expect(gate.mayOpen).toBe(true);
    // openDiscovery opens only DEVELOP buckets; a revision routed to CODE would still be shut.
    expect(gate.route).toBe('DEVELOP');
    expect(gate.revision).toContain('Revision 2 (HIGH_FALSE_POSITIVES)');
    expect((await versions(bucket.id)).map((m) => m.version)).toEqual([1, 2]);
  });

  it('pauses with a retry time once revisions are exhausted, and never closes the bucket for good', async () => {
    const bucket = SEARCH_BUCKETS[2]!;
    for (let r = 0; r < MAX_REVISIONS; r += 1) {
      for (let i = 0; i < FAILURE_STREAK; i += 1) await recordRoundAsRun(projectId, bucket, DUPLICATES);
    }
    expect((await versions(bucket.id)).map((m) => m.version)).toEqual([1, 2, 3, 4]);
    let last = null as Awaited<ReturnType<typeof recordRoundAsRun>>;
    for (let i = 0; i < FAILURE_STREAK; i += 1) last = await recordRoundAsRun(projectId, bucket, DUPLICATES);
    expect((await versions(bucket.id)).map((m) => m.version)).toEqual([1, 2, 3, 4]);
    expect(last?.decision.action).toBe('PAUSE');
    expect(last?.decision.retryAt).not.toBeNull();

    const now = new Date().toISOString();
    const gate = (await bucketGates(projectId, [bucket.id], now)).get(bucket.id)!;
    expect(gate).toMatchObject({ mayOpen: false, decision: { action: 'PAUSE', cause: 'HIGH_FALSE_POSITIVES' } });
    const later = new Date(Date.now() + MAX_RETRY_MS + 60_000).toISOString();
    expect((await bucketGates(projectId, [bucket.id], later)).get(bucket.id)?.mayOpen).toBe(true);
  });

  it('words a stale revision as a change of where to look', () => {
    const words = revisionInstruction('STALE', [{ surfaced: 0, rejected: 0, finishedAt: '2026-11-01T00:00:00.000Z' }], '2026-08-01T00:00:00.000Z');
    expect(words).toContain('since 2026-08-01');
    expect(words).toContain('sources earlier rounds did not use');
  });
});
