/**
 * MEM-32, owner policy: a goal's owner decisions are explicit numbered versions
 * derived from the append-only events `decide.ts` already writes — no new table,
 * no new writer — and an older report cannot override a newer authorized
 * instruction. An unknown is never treated as favourable (invariant 39).
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { createWorkstream } from '../server/repos/register.ts';
import { changeObjective, pause, resume, setTerms } from '../server/services/goals/decide.ts';
import { getDb } from '../server/db/database.ts';
import {
  OWNER_POLICY_EVENT_KINDS,
  governingFrom,
  governingPolicy,
  policyVersions,
  staleAgainstPolicy,
} from '../server/services/goals/ownerPolicy.ts';
import type { WorkstreamEvent } from '../server/domain/register.ts';

const event = (id: string, kind: string, createdAt: string, over: Partial<WorkstreamEvent> = {}): WorkstreamEvent => ({
  id,
  workstreamId: 'wst_g',
  kind,
  summary: kind,
  detail: {},
  actorRef: 'person:usr_owner',
  createdAt,
  ...over,
});

const EVENTS: WorkstreamEvent[] = [
  event('wse_3', 'GOAL_PAUSED', '2026-11-03T00:00:00.000Z'),
  event('wse_1', 'GOAL_TERMS_SET', '2026-11-01T00:00:00.000Z', { detail: { before: { dueAt: null }, after: { dueAt: '2026-12-01' } } }),
  event('wse_x', 'GOAL_PLAN_READ', '2026-11-02T00:00:00.000Z'),
  event('wse_2', 'GOAL_OBJECTIVE_CHANGED', '2026-11-02T12:00:00.000Z', { actorRef: 'person:usr_other', detail: { before: { intent: 'old' }, after: { intent: 'Sell e.g. bookkeeping or anything else that pays' } } }),
  event('wse_o', 'GOAL_TERMS_SET', '2026-11-04T00:00:00.000Z', { workstreamId: 'wst_other' }),
];

describe('versions are numbered from the owner decisions, in the order they were made', () => {
  it('orders by time, skips other kinds and other goals, and links each to what it superseded', () => {
    const versions = policyVersions('wst_g', EVENTS);
    expect(versions.map((one) => [one.version, one.eventId, one.kind, one.supersedes])).toEqual([
      [1, 'wse_1', 'GOAL_TERMS_SET', null],
      [2, 'wse_2', 'GOAL_OBJECTIVE_CHANGED', 1],
      [3, 'wse_3', 'GOAL_PAUSED', 2],
    ]);
    // What the owner wrote is kept verbatim as data — an example in their words is not a list of what is allowed.
    expect(versions[1]!.detail).toEqual({ before: { intent: 'old' }, after: { intent: 'Sell e.g. bookkeeping or anything else that pays' } });
    expect(versions[1]!.actorRef).toBe('person:usr_other');
  });

  it('governs by the newest version, with its event, time, actor and the version it replaced', () => {
    const policy = governingFrom('wst_g', policyVersions('wst_g', EVENTS));
    expect(policy).toMatchObject({ known: true, version: 3, eventId: 'wse_3', kind: 'GOAL_PAUSED', decidedAt: '2026-11-03T00:00:00.000Z', actorRef: 'person:usr_owner', supersedes: 2 });
  });

  it('reads the decision kinds decide.ts writes, and nothing else', () => {
    const source = readFileSync('server/services/goals/decide.ts', 'utf8');
    for (const kind of OWNER_POLICY_EVENT_KINDS) expect(source).toContain(`kind: '${kind}'`);
  });
});

describe('an older report cannot override a newer authorized instruction', () => {
  const policy = governingFrom('wst_g', policyVersions('wst_g', EVENTS));

  it('refuses a report produced under an older version, naming both versions', () => {
    const verdict = staleAgainstPolicy('2026-11-02T18:00:00.000Z', policy);
    expect(verdict).toMatchObject({ verdict: 'STALE', accepted: false, governingVersion: 3, producedUnder: 2 });
    expect(verdict.reason).toMatch(/version 2 \(GOAL_OBJECTIVE_CHANGED/);
    expect(verdict.reason).toMatch(/version 3 \(GOAL_PAUSED/);
  });

  it('refuses a report from before any recorded decision, and says so', () => {
    const verdict = staleAgainstPolicy('2026-10-01T00:00:00.000Z', policy);
    expect(verdict).toMatchObject({ verdict: 'STALE', accepted: false, producedUnder: 0 });
    expect(verdict.reason).toMatch(/no recorded owner decision/);
  });

  it('accepts a report produced at or after the governing version', () => {
    expect(staleAgainstPolicy('2026-11-03T00:00:00.000Z', policy)).toMatchObject({ verdict: 'CURRENT', accepted: true, governingVersion: 3, producedUnder: 3 });
    expect(staleAgainstPolicy('2026-11-05T09:00:00.000Z', policy)).toMatchObject({ verdict: 'CURRENT', accepted: true });
  });

  it('treats an unknown policy or an unreadable time as unknown, never as current', () => {
    const none = governingFrom('wst_none', []);
    expect(none.known).toBe(false);
    expect(staleAgainstPolicy('2026-11-05T09:00:00.000Z', none)).toMatchObject({ verdict: 'UNKNOWN', accepted: false, governingVersion: null });
    for (const at of [null, undefined, '', 'not a date']) {
      expect(staleAgainstPolicy(at, policy)).toMatchObject({ verdict: 'UNKNOWN', accepted: false, governingVersion: 3 });
    }
  });
});

describe('on the real store, from the decisions a person made', () => {
  let projectId = '';
  let userId = '';
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  beforeEach(async () => {
    projectId = (await freshProject()).project.id;
    userId = (await createUser({ email: `op-${Math.random().toString(36).slice(2, 10)}@example.test`, displayName: 'Owner', password: 'correct horse battery staple' })).id;
  });

  it('derives the versions from decide.ts events, writes nothing, and refuses a reading taken before the latest decision', async () => {
    const goal = await createWorkstream({ projectId, title: 'Collect cash', intent: 'Collect settled cash.', purpose: 'REVENUE_DIRECT', createdByUserId: userId });
    expect(await governingPolicy(goal.id)).toMatchObject({ known: false });

    const actor = `person:${userId}`;
    expect((await setTerms(goal.id, { dueAt: '2026-12-31T00:00:00.000Z', ownerUserId: userId }, actor)).ok).toBe(true);
    await tick();
    const readingAt = new Date().toISOString();
    await tick();
    expect((await changeObjective(goal.id, { intent: 'Collect settled cash from repeat buyers.' }, actor)).ok).toBe(true);
    await tick();
    expect((await pause(goal.id, 'Waiting for capital.', actor)).ok).toBe(true);
    await tick();
    expect((await resume(goal.id, actor)).ok).toBe(true);

    const count = async () => Number((await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM workstream_events WHERE workstream_id = ?', [goal.id]))!.n);
    const before = await count();
    const policy = await governingPolicy(goal.id);
    expect(await count()).toBe(before);
    expect(policy).toMatchObject({ known: true, version: 4, kind: 'GOAL_RESUMED', actorRef: actor, supersedes: 3 });
    if (!policy.known) throw new Error('unknown');
    expect(policy.versions.map((one) => one.kind)).toEqual(['GOAL_TERMS_SET', 'GOAL_OBJECTIVE_CHANGED', 'GOAL_PAUSED', 'GOAL_RESUMED']);
    // The objective change kept what it replaced, and the version carries it.
    expect(policy.versions[1]!.detail).toMatchObject({ before: { intent: 'Collect settled cash.' }, after: { intent: 'Collect settled cash from repeat buyers.' } });

    const stale = staleAgainstPolicy(readingAt, policy);
    expect(stale).toMatchObject({ verdict: 'STALE', accepted: false, governingVersion: 4, producedUnder: 1 });
    expect(staleAgainstPolicy(new Date().toISOString(), policy)).toMatchObject({ verdict: 'CURRENT', accepted: true });
  });

  it('creates no table and has no writer of its own', () => {
    const source = readFileSync('server/services/goals/ownerPolicy.ts', 'utf8');
    expect(source).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|CREATE TABLE)\b/);
    expect(source).not.toMatch(/recordWorkstreamEvent|getDb\(/);
  });
});
