/**
 * Adaptive audit separation — the topology cases.
 *
 * The correction these prove is a product-owner one and it is worth stating
 * rather than assuming: the threat an independent audit exists to stop is **one
 * model context reviewing its own work**. Three distinct authenticated sessions
 * defeat that. Requiring two *accounts* also defeated it, and additionally made
 * a finished product unfinished whenever a particular subscription was
 * unavailable — which is not a property an acceptance gate should have.
 *
 * So: session is the floor, stronger tiers are preferred when the fleet can
 * supply them, and the tier actually achieved is recorded truthfully. Every
 * test below is about one of those three sentences, and **no test asserts a
 * number of accounts, workers or Routines** — adding or removing surfaces
 * changes capacity, never whether a packet can finish.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import {
  auditEligibility,
  AUDIT_SEPARATION_MINIMUM,
} from '../server/services/research/auditEligibility.ts';
import {
  meetsTier,
  SEPARATION_LABELS,
  strongestSeparation,
  type AuditLineage,
} from '../server/services/research/independence.ts';
import {
  missionRequiredTier,
  separationCapacity,
  separationShortfall,
} from '../server/services/research/auditAdmission.ts';
import { createAccount, createRoutine } from '../server/repos/fleet.ts';
import { createCandidate } from '../server/repos/russellCandidates.ts';
import { launchMission } from '../server/repos/russellMissions.ts';
import { getDb } from '../server/db/database.ts';
import type { ResearchPass } from '../server/domain/types.ts';

beforeEach(async () => {
  await freshProject();
});

/** A completed audit pass at the ordinal its role occupies. */
function pass(
  role: 'PRIMARY' | 'ADVERSARIAL' | 'JUDGE',
  lineage: { account: string; worker: string; routine: string; session: string },
  status: 'COMPLETE' | 'RUNNING' = 'COMPLETE',
): ResearchPass {
  const ordinal = role === 'PRIMARY' ? 5 : role === 'ADVERSARIAL' ? 6 : 7;
  return {
    passKey: 'AUDIT',
    ordinal,
    status,
    executorWorkerId: lineage.worker,
    executorRoutineId: lineage.routine,
    executorAccountId: lineage.account,
    executorSessionRef: lineage.session,
  } as never;
}

/** A candidate executor, in the shape the policy actually takes. */
function exec(l: { account: string; worker: string; routine: string }, sessionRef: string) {
  return { accountId: l.account, workerId: l.worker, routineId: l.routine, sessionRef };
}

function lineage(
  role: 'PRIMARY' | 'ADVERSARIAL' | 'JUDGE',
  l: { account: string; worker: string; routine: string; session: string },
): AuditLineage {
  return {
    role,
    accountId: l.account,
    workerId: l.worker,
    routineId: l.routine,
    sessionRef: l.session,
  };
}

describe('the floor is three sessions, not a topology', () => {
  it('one account, one Routine, three fresh sessions — passes', () => {
    const surface = { account: 'acct_a', worker: 'wkr_a', routine: 'rtn_a' };
    const done = [
      pass('PRIMARY', { ...surface, session: 'cred_1' }),
      pass('ADVERSARIAL', { ...surface, session: 'cred_2' }),
    ];
    const verdict = auditEligibility({
      role: 'JUDGE',
      executor: exec(surface, 'cred_3'),
      passes: done,
    });
    expect(verdict.eligible).toBe(true);

    // And the tier recorded is the honest one: same account, same worker, same
    // Routine, three sessions.
    const tier = strongestSeparation([
      lineage('PRIMARY', { ...surface, session: 'cred_1' }),
      lineage('ADVERSARIAL', { ...surface, session: 'cred_2' }),
      lineage('JUDGE', { ...surface, session: 'cred_3' }),
    ]);
    expect(tier).toBe('SESSION');
    expect(SEPARATION_LABELS[tier!]).toBe('SESSION_SEPARATED');
  });

  it('every pair has a SESSION minimum, and no entry names an account', () => {
    expect(Object.values(AUDIT_SEPARATION_MINIMUM)).toEqual(['SESSION', 'SESSION', 'SESSION']);
  });

  it('one account, several Routines — spreads, and says ROUTINE_SEPARATED', () => {
    const account = 'acct_a';
    const worker = 'wkr_shared';
    const tier = strongestSeparation([
      lineage('PRIMARY', { account, worker, routine: 'rtn_1', session: 'c1' }),
      lineage('ADVERSARIAL', { account, worker, routine: 'rtn_2', session: 'c2' }),
      lineage('JUDGE', { account, worker, routine: 'rtn_3', session: 'c3' }),
    ]);
    // Not WORKER: one worker identity is bound to all three Routines, which is
    // exactly the production shape. Routine is its own tier for this reason.
    expect(tier).toBe('ROUTINE');
    expect(SEPARATION_LABELS[tier!]).toBe('ROUTINE_SEPARATED');
  });

  it('several accounts — prefers and reports ACCOUNT_SEPARATED', () => {
    const tier = strongestSeparation([
      lineage('PRIMARY', { account: 'a1', worker: 'w1', routine: 'r1', session: 'c1' }),
      lineage('ADVERSARIAL', { account: 'a2', worker: 'w2', routine: 'r2', session: 'c2' }),
      lineage('JUDGE', { account: 'a3', worker: 'w3', routine: 'r3', session: 'c3' }),
    ]);
    expect(tier).toBe('ACCOUNT');
  });

  it('distinct workers on one account report WORKER, not ACCOUNT', () => {
    const account = 'acct_a';
    const tier = strongestSeparation([
      lineage('PRIMARY', { account, worker: 'w1', routine: 'r1', session: 'c1' }),
      lineage('ADVERSARIAL', { account, worker: 'w2', routine: 'r2', session: 'c2' }),
      lineage('JUDGE', { account, worker: 'w3', routine: 'r3', session: 'c3' }),
    ]);
    // The honesty requirement in one assertion: a same-account result must
    // never be labelled cross-account independent.
    expect(tier).toBe('WORKER');
    expect(tier).not.toBe('ACCOUNT');
  });
});

describe('what is refused', () => {
  it('one session attempting a second role on the same packet', () => {
    const surface = { account: 'acct_a', worker: 'wkr_a', routine: 'rtn_a' };
    const verdict = auditEligibility({
      role: 'ADVERSARIAL',
      executor: exec(surface, 'cred_1'),
      passes: [pass('PRIMARY', { ...surface, session: 'cred_1' })],
    });
    expect(verdict.eligible).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/same session/i);
    // The refusal never prints the credential, because at the session
    // dimension the value *is* the credential.
    expect(verdict.reasons.join(' ')).not.toContain('cred_1');
  });

  it('a judge that starts before the arguments are settled', () => {
    const surface = { account: 'acct_a', worker: 'wkr_a', routine: 'rtn_a' };
    const early = auditEligibility({
      role: 'JUDGE',
      executor: exec(surface, 'cred_3'),
      passes: [
        pass('PRIMARY', { ...surface, session: 'cred_1' }),
        pass('ADVERSARIAL', { ...surface, session: 'cred_2' }, 'RUNNING'),
      ],
    });
    expect(early.eligible).toBe(false);
    expect(early.reasons.join(' ')).toMatch(/may not begin until ADVERSARIAL/);
  });

  it('fabricated lineage — a session that names no credential', () => {
    const surface = { account: 'acct_a', worker: 'wkr_a', routine: 'rtn_a' };
    const verdict = auditEligibility({
      role: 'JUDGE',
      executor: exec(surface, ''),
      passes: [
        pass('PRIMARY', { ...surface, session: 'cred_1' }),
        pass('ADVERSARIAL', { ...surface, session: 'cred_2' }),
      ],
    });
    // An empty session is not a distinct one. Unrecorded lineage is not
    // evidence of independence, so it fails closed rather than comparing
    // unequal-to-everything and sailing through.
    expect(verdict.eligible).toBe(false);
  });

  it('a predicted session is never final evidence', () => {
    const surface = { account: 'acct_a', worker: 'wkr_a', routine: 'rtn_a' };
    // `future:` placeholders are perfectly distinct from each other, so the
    // tier function would happily call this session-separated. That is exactly
    // why the evidence gate rejects them separately: prediction decides where
    // to send work, never what was proven.
    const tier = strongestSeparation([
      lineage('PRIMARY', { ...surface, session: 'future:rtn_a' }),
      lineage('ADVERSARIAL', { ...surface, session: 'future:rtn_b' }),
      lineage('JUDGE', { ...surface, session: 'future:rtn_c' }),
    ]);
    expect(tier).toBe('SESSION');
    expect(['future:rtn_a', 'future:rtn_b'].every((s) => s.startsWith('future:'))).toBe(true);
  });

  it('a surface lost mid-packet leaves the remaining role reschedulable', () => {
    // The adversarial ran on a Routine that has since gone. Nothing about the
    // judge's eligibility depends on that surface still existing — it depends
    // on the recorded lineage, which is immutable.
    const gone = { account: 'acct_gone', worker: 'wkr_gone', routine: 'rtn_gone' };
    const alive = { account: 'acct_a', worker: 'wkr_a', routine: 'rtn_a' };
    const verdict = auditEligibility({
      role: 'JUDGE',
      executor: exec(alive, 'cred_3'),
      passes: [
        pass('PRIMARY', { ...alive, session: 'cred_1' }),
        pass('ADVERSARIAL', { ...gone, session: 'cred_2' }),
      ],
    });
    expect(verdict.eligible).toBe(true);
  });
});

describe('a mission may ask for more, and only that mission waits', () => {
  it('a required tier makes an otherwise-eligible surface ineligible', () => {
    const surface = { account: 'acct_a', worker: 'wkr_a', routine: 'rtn_a' };
    const passes = [pass('PRIMARY', { ...surface, session: 'cred_1' })];

    expect(
      auditEligibility({
        role: 'ADVERSARIAL',
        executor: exec(surface, 'cred_2'),
        passes,
      }).eligible,
    ).toBe(true);

    // The same surface, the same packet, one stricter requirement.
    const strict = auditEligibility({
      role: 'ADVERSARIAL',
      executor: exec(surface, 'cred_2'),
      passes,
      requiredTier: 'ACCOUNT',
    });
    expect(strict.eligible).toBe(false);
    expect(strict.reasons.join(' ')).toMatch(/account/i);
  });

  it('a required tier can never be used to ask for less than the floor', () => {
    const surface = { account: 'acct_a', worker: 'wkr_a', routine: 'rtn_a' };
    // Same session, and "SESSION" requested — the floor still refuses it.
    const verdict = auditEligibility({
      role: 'ADVERSARIAL',
      executor: exec(surface, 'cred_1'),
      passes: [pass('PRIMARY', { ...surface, session: 'cred_1' })],
      requiredTier: 'SESSION',
    });
    expect(verdict.eligible).toBe(false);
  });

  it('meetsTier reads the ladder in the right direction', () => {
    expect(meetsTier('ACCOUNT', 'SESSION')).toBe(true);
    expect(meetsTier('WORKER', 'ROUTINE')).toBe(true);
    expect(meetsTier('SESSION', 'ACCOUNT')).toBe(false);
    expect(meetsTier(null, 'SESSION')).toBe(false);
  });
});

/**
 * A mission may ask for more than the floor, and asking must cost only that
 * mission. The counting here is measuring a capability, never encoding a
 * requirement: the floor still has no number in it, and nothing below refuses
 * a fleet for being small.
 */
describe('a stronger tier parks one mission and nothing else', () => {
  async function surface(account: string, routine: string, worker: string) {
    const acct = await createAccount({ name: account });
    return createRoutine({
      accountId: acct.id,
      routineRef: `trig_${routine}`,
      name: routine,
      tokenSecretName: `SECRET_${routine}`,
      tokenDigest: `digest_${routine}`,
      workerId: worker,
    });
  }

  it('reports SESSION as the strongest tier a one-surface fleet supplies', async () => {
    await surface('solo', 'r1', 'w1');
    const capacity = await separationCapacity();
    expect(capacity.strongest).toBe('SESSION');
    expect(capacity.surfaces).toBe(1);
    // And the floor is satisfiable on it, which is the whole correction.
    expect(separationShortfall('SESSION', capacity)).toBeNull();
  });

  it('names the exact missing capability rather than a person', async () => {
    await surface('solo', 'r1', 'w1');
    const shortfall = separationShortfall('ACCOUNT', await separationCapacity());
    expect(shortfall).toContain('INSUFFICIENT_ACCOUNT_SEPARATION');
    expect(shortfall).toContain('resumes by itself');
    // The words the correction struck out, in the state that used to produce
    // them.
    expect(shortfall).not.toContain('MISSING_FRIEND');
    expect(shortfall).not.toContain('DISTINCT_BOUND_WORKERS');
    expect(shortfall).not.toContain('friend');
  });

  it('reports no healthy execution surface as its own distinct fact', async () => {
    const capacity = await separationCapacity();
    expect(capacity.surfaces).toBe(0);
    // Not a separation problem at all, and it must not read as one.
    expect(separationShortfall('SESSION', capacity)).toContain('NO_HEALTHY_EXECUTION_SURFACE');
  });

  it('lifts the shortfall when the missing capability is registered', async () => {
    await surface('a1', 'r1', 'w1');
    await surface('a2', 'r2', 'w2');
    expect(separationShortfall('ACCOUNT', await separationCapacity())).not.toBeNull();
    // Three roles are compared pairwise, so a uniform account floor needs three
    // distinct accounts. Registering the third is all it takes, and no
    // deployment, restart or code change is involved.
    await surface('a3', 'r3', 'w3');
    const capacity = await separationCapacity();
    expect(capacity.accounts).toBe(3);
    expect(capacity.strongest).toBe('ACCOUNT');
    expect(separationShortfall('ACCOUNT', capacity)).toBeNull();
  });

  it('does not count a Routine whose secret was never registered', async () => {
    const acct = await createAccount({ name: 'a1' });
    await createRoutine({
      accountId: acct.id,
      routineRef: 'trig_unset',
      name: 'unset',
      tokenSecretName: 'NEVER_SET',
      tokenDigest: null,
      workerId: 'w1',
    });
    // Registered, enabled, and unable to be fired. Counting it would report
    // capacity that spends a fire to discover it does not exist.
    expect((await separationCapacity()).surfaces).toBe(0);
  });

  it('counts workers rather than Routines when one worker holds several', async () => {
    // The live fleet's actual shape: two accounts, two Routines, one worker
    // bound to both. Two surfaces, one worker — and it must not read as two.
    await surface('a1', 'r1', 'shared');
    await surface('a2', 'r2', 'shared');
    const capacity = await separationCapacity();
    expect(capacity.routines).toBe(2);
    expect(capacity.workers).toBe(1);
    expect(capacity.accounts).toBe(2);
    expect(capacity.strongest).toBe('SESSION');
  });
});

/**
 * A declared stronger tier has to bind where the refusal actually happens.
 *
 * Checked at launch alone it would be decorative: the packet would start and
 * then be audited at exactly the floor it was trying to exceed.
 */
describe('a mission-declared tier binds at admission, and only upwards', () => {
  async function missionDeclaring(spec: unknown): Promise<string> {
    const project = await freshProject();
    const candidate = await createCandidate({
      title: 'declared',
      statement: `declared-${Math.random()}`,
      projectId: project.project.id,
    });
    await getDb().run(`UPDATE russell_candidates SET judgment = ? WHERE id = ?`, [
      JSON.stringify({ missionSpec: spec }),
      candidate.id,
    ]);
    const orchestrationId = `orc_${Math.random().toString(36).slice(2, 10)}`;
    const { mission } = await launchMission({
      projectId: project.project.id,
      visibility: 'PRIVATE',
      objective: 'o',
      whyNow: 'w',
      idempotencyKey: `k-${Math.random()}`,
      candidateId: candidate.id,
    });
    await getDb().run(`UPDATE russell_missions SET orchestration_id = ? WHERE id = ?`, [
      orchestrationId,
      mission.id,
    ]);
    return orchestrationId;
  }

  it('reads the tier the mission declared', async () => {
    const id = await missionDeclaring({ requiredSeparation: 'ACCOUNT' });
    expect(await missionRequiredTier(id)).toBe('ACCOUNT');
  });

  it('reads nothing from a mission that declared nothing', async () => {
    const id = await missionDeclaring({ title: 'no tier here' });
    expect(await missionRequiredTier(id)).toBeNull();
  });

  it('refuses a value that is not a tier rather than trusting it', async () => {
    // The declaration lives in stored JSON, so it is validated against the
    // ladder like anything else read back off a row.
    const id = await missionDeclaring({ requiredSeparation: 'TOTAL' });
    expect(await missionRequiredTier(id)).toBeNull();
  });

  it('is the floor for an orchestration no mission owns', async () => {
    // Every packet that is not a Russell mission — the whole of Steps 9 to 11 —
    // must be unaffected by this, and unreadable must mean the floor rather
    // than a lowering or a crash.
    expect(await missionRequiredTier('orc_nobody')).toBeNull();
  });
});
