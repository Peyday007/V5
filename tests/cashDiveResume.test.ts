/**
 * A round that researched nothing is given back, and only that one.
 *
 * Production, 2026-10-01: 32 of 40 openings sat BLOCKED at round 2 of 2 with
 * `candidate=QUEUED mission=— passes 0/0` — every dive's idea was stuck behind
 * the launch window and the six-hour backstop closed it. `resumeUnlaunchedDives`
 * is the repair, and these pin what it may and may not give back.
 */
import { describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createUser } from '../server/repos/identity.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { createCandidate, getCandidate, recordJudgment, transitionCandidate } from '../server/repos/russellCandidates.ts';
import { launchMission, transitionMission } from '../server/repos/russellMissions.ts';
import { createOpportunity, getOpportunity, updateOpportunity } from '../server/repos/cashPortfolio.ts';
import { listCashEventsFor, recordCashEvent } from '../server/repos/cashMode.ts';
import { resumeUnlaunchedDives, whyNotDiving } from '../server/services/cash/validation.ts';

describe('resuming a deep dive that never launched', () => {
  it('gives back exactly the rounds that researched nothing, once', async () => {
    const fixture = await freshProject();
    const projectId = fixture.project.id;
    const owner = await createUser({
      email: 'resume@example.com',
      displayName: 'Peyton',
      password: 'a-long-enough-password',
      isBrainAdmin: true,
    });
    const started = await activate({
      projectId,
      ownerUserId: owner.id,
      actorUserId: owner.id,
      objective: 'Maximize additional usable cash over the next few weeks.',
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const idea = async (title: string) => {
      const candidate = await createCandidate({ projectId, visibility: 'SHARED', title, statement: title });
      await recordJudgment({
        candidateId: candidate.id,
        state: 'QUEUED',
        priority: 'WORTH_DOING',
        reason: 'test',
        judgment: { missionSpec: { projectId, objective: title } },
      });
      return candidate.id;
    };
    const ran = async (candidateId: string, key: string) => {
      const { mission } = await launchMission({
        projectId,
        visibility: 'SHARED',
        objective: key,
        whyNow: 'test',
        idempotencyKey: key,
        candidateId,
      });
      await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'FAILED', terminalReason: 'x' });
    };
    const opening = async (title: string, rounds: string[], current: string) => {
      const made = await createOpportunity({
        projectId,
        cashModeId: started.mode.id,
        ownerUserId: owner.id,
        title,
        mechanism: 'EXPLICIT_PAID_REQUEST',
        currency: 'USD',
      });
      for (const [index, candidateId] of rounds.entries()) {
        await recordCashEvent({
          projectId,
          opportunityId: made.id,
          kind: 'CASH_VALIDATION_STARTED',
          actorRef: 'BRAIN',
          summary: 'started',
          detail: { candidateId, round: index + 1 },
        });
      }
      await updateOpportunity(made.id, {
        candidate_id: current,
        buying_signal: 'A county published a paid request.',
        validation_state: 'BLOCKED',
        validation_started_at: new Date(Date.now() - 86_400_000).toISOString(),
        validation_settled_at: new Date().toISOString(),
        validation_rounds: rounds.length,
      });
      return made.id;
    };

    // Both rounds stalled before launch.
    const a1 = await idea('a round 1');
    const a2 = await idea('a round 2');
    const neither = await opening('neither round launched', [a1, a2], a2);

    // Round 1 really ran; round 2 stalled before launch.
    const b1 = await idea('b round 1');
    await ran(b1, 'b1');
    const b2 = await idea('b round 2');
    const oneRan = await opening('first round ran', [b1, b2], b2);

    // Its current idea launched: that round counts, and nothing is touched.
    const c1 = await idea('c round 1');
    await ran(c1, 'c1');
    const launched = await opening('current round launched', [c1], c1);

    // Parked for a reason of its own: not a stall, left alone.
    const d1 = await idea('d round 1');
    await transitionCandidate({ candidateId: d1, from: 'QUEUED', to: 'PARKED' });
    const parked = await opening('parked dive', [d1], d1);

    expect((await whyNotDiving((await getOpportunity(neither))!)).kind).toBe('ROUNDS_SPENT');

    const resumed = await resumeUnlaunchedDives(projectId);
    expect(resumed.sort()).toEqual([neither, oneRan].sort());

    const n = (await getOpportunity(neither))!;
    expect(n.validationState).toBe('PENDING');
    expect(n.candidateId).toBe(a2); // the same question, not a new one
    expect(n.validationRounds).toBe(1); // the resumed round, and nothing else
    // The earlier idea would otherwise launch a mission no opening owns.
    expect((await getCandidate(a1))!.state).toBe('PARKED');
    expect((await getCandidate(a2))!.state).toBe('QUEUED');

    const o = (await getOpportunity(oneRan))!;
    expect(o.validationState).toBe('PENDING');
    expect(o.validationRounds).toBe(2); // the round that ran still counts

    expect((await getOpportunity(launched))!.validationState).toBe('BLOCKED');
    expect((await getOpportunity(launched))!.validationRounds).toBe(1);
    expect((await getOpportunity(parked))!.validationState).toBe('BLOCKED');

    // History kept and the reason recorded.
    const events = await listCashEventsFor(neither, 50);
    const record = events.find((event) => event.kind === 'CASH_VALIDATION_RESUMED')!;
    expect(record.detail).toMatchObject({ candidateId: a2, fromRounds: 2, toRounds: 1, restoredRounds: 1 });
    expect(events.filter((event) => event.kind === 'CASH_VALIDATION_STARTED')).toHaveLength(2);

    // Twice is once.
    expect(await resumeUnlaunchedDives(projectId)).toEqual([]);

    // And the same idea is never resumed a second time: if it stalls again it
    // stays BLOCKED rather than cycling every six hours.
    await updateOpportunity(neither, { validation_state: 'BLOCKED' });
    expect(await resumeUnlaunchedDives(projectId)).not.toContain(neither);
  });
});
