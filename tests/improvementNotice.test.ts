/**
 * The owner is told once, through the connected channel, when Brain completes a verified
 * autonomous self-improvement cycle (owner's order, 2026-11-12): Hermes found a real
 * deficiency, commissioned Factory, Factory merged, deployed and verified it, Hermes received
 * the result and evaluated it against the goal. A release alone is never that message.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const factory = vi.hoisted(() => ({ status: 'LIVE' as string, deployed: true }));

vi.mock('../server/repos/factory.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/repos/factory.ts')>();
  return {
    ...actual,
    getCampaignByChangeRequest: vi.fn(async (id: string) => ({ id: `fcp_for_${id}` })),
    listUnits: vi.fn(async () => [{ unitKey: 'verify', kind: 'VERIFICATION', state: 'DONE', ownedPaths: ['server/services/russell/needsHuman.ts'] }]),
  };
});
vi.mock('../server/services/factory/release/outcome.ts', () => ({
  objectiveOutcome: vi.fn(async () => ({
    status: factory.status,
    detail: factory.status === 'LIVE' ? 'Live and verified.' : 'Building.',
    blocker: null,
    prUrl: 'https://github.com/peyday007/v5/pull/901',
    release: factory.status === 'LIVE' ? { mergeSha: 'abcdef1234567890' } : null,
  })),
}));
vi.mock('../server/services/factory/delivery.ts', () => ({
  latestDelivery: vi.fn(async () => (factory.status === 'LIVE' ? { state: 'MERGED', mergeSha: 'abcdef1234567890', deployed: factory.deployed } : null)),
}));

import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { decideCandidate, listImprovementEvents, patchCandidate, recordImprovementEvent, upsertCandidate } from '../server/repos/improvement.ts';
import { finishOperatorRun, startOperatorRun } from '../server/repos/operator.ts';
import { improvementNotice, verifiedCycle, type CycleFacts } from '../server/domain/engineeringDirector.ts';

/* ------------------------------------------------------------------------- */
/* The rule, on facts                                                         */
/* ------------------------------------------------------------------------- */

function facts(over: Partial<CycleFacts> = {}): CycleFacts {
  return {
    candidateId: 'imp_1',
    title: 'Moot cards reopen and hold the goal on a person',
    deficiency: 'RECURRING_OPERATIONAL_FAILURE',
    problem: 'The goal reads BLOCKED on a person while every open card is moot.',
    goalId: 'goal_10k',
    goalTitle: '$10K settled cash',
    origin: 'OPERATOR',
    commissionedByRun: 'opr_1',
    intervention: 'ENGINEERING',
    campaignId: 'fcp_1',
    factory: { status: 'LIVE', prUrl: 'https://github.com/peyday007/v5/pull/901', mergeSha: 'abcdef1234567890', deployed: true, verified: true, changedPaths: ['server/services/russell/needsHuman.ts'], tests: 'verify:DONE' },
    measurement: { metric: 'OWNER_INTERVENTIONS_PER_DAY', before: 4, after: 1, verdict: 'IMPROVED' },
    decision: 'KEPT',
    decisionReason: 'owner interventions fell 4 → 1 a day',
    decidedAt: '2026-11-12T10:00:00.000Z',
    status: 'RESOLVED',
    goal: { effect: 'IMPROVED', reasons: ['no longer waiting on a person (BRAIN)'] },
    evaluation: { runId: 'opr_2', recordedAt: '2026-11-12T11:00:00.000Z', lesson: 'Withdrawing moot cards put the goal back on Brain work.' },
    ...over,
  };
}

describe('only a whole verified cycle is an improvement worth telling the owner', () => {
  it('passes when all five steps are proved by rows', () => {
    const cycle = verifiedCycle(facts());
    expect(cycle.verified).toBe(true);
    expect(Object.values(cycle.steps).every((s) => s === null)).toBe(true);
  });

  it("refuses a deficiency Brain's standing director commissioned in Hermes' place", () => {
    expect(verifiedCycle(facts({ origin: 'STANDING_DIRECTOR' })).steps.IDENTIFIED_BY_HERMES).toMatch(/standing director/);
    expect(verifiedCycle(facts({ commissionedByRun: null })).verified).toBe(false);
  });

  it('refuses a remedy that never went to Factory', () => {
    expect(verifiedCycle(facts({ intervention: 'STRATEGY' })).steps.COMMISSIONED_FACTORY).toMatch(/STRATEGY/);
    expect(verifiedCycle(facts({ campaignId: null })).verified).toBe(false);
  });

  it('refuses anything short of merged, deployed and verified live', () => {
    const f = facts().factory!;
    expect(verifiedCycle(facts({ factory: { ...f, mergeSha: null } })).steps.RELEASED_AND_VERIFIED).toBe('not merged');
    expect(verifiedCycle(facts({ factory: { ...f, deployed: false } })).steps.RELEASED_AND_VERIFIED).toBe('not deployed');
    expect(verifiedCycle(facts({ factory: { ...f, verified: false, status: 'RELEASING' } })).steps.RELEASED_AND_VERIFIED).toMatch(/not verified live/);
  });

  it('never counts a release as the improvement: a delivery without a kept, improved measurement is refused', () => {
    const release = verifiedCycle(facts({ status: 'DELIVERED_UNMEASURED', decision: null, measurement: null }));
    expect(release.verified).toBe(false);
    expect(release.steps.RESULT_RECEIVED).toMatch(/no demonstrated improvement/);
    expect(verifiedCycle(facts({ status: 'NOT_RESOLVED', decision: 'KEPT_NO_EFFECT' })).verified).toBe(false);
  });

  it('waits for Hermes to receive the result and evaluate it against the goal, after the measurement', () => {
    expect(verifiedCycle(facts({ evaluation: null })).steps.GOAL_EVALUATED).toMatch(/not evaluated/);
    expect(verifiedCycle(facts({ evaluation: { runId: 'opr_0', recordedAt: '2026-11-12T09:00:00.000Z', lesson: 'early' } })).steps.GOAL_EVALUATED).toMatch(/predates/);
  });
});

describe('the message', () => {
  it('names the problem, what was fixed and what improved, and keeps the release apart from the improvement', () => {
    const { subject, text } = improvementNotice(facts(), 1);
    expect(subject).toMatch(/first verified autonomous self-improvement/);
    expect(text).toContain('THE PROBLEM HERMES FOUND');
    expect(text).toContain('WHAT BRAIN FIXED — the software release (a release is not, by itself, an improvement)');
    expect(text).toContain('WHAT ACTUALLY IMPROVED — measured on production after the release');
    expect(text).toContain('OWNER_INTERVENTIONS_PER_DAY: 4 → 1 (IMPROVED)');
    expect(text).toContain('pull/901');
    expect(text).toContain('The goal itself moved.');
    expect(text).toContain("HERMES' EVALUATION");
  });

  it('says so when the metric improved and the goal did not, and numbers later improvements', () => {
    const { subject, text } = improvementNotice(facts({ goal: { effect: 'UNCHANGED', reasons: ['every reading is as it was'] } }), 2);
    expect(subject).toMatch(/verified #2/);
    expect(text).toContain('second verified');
    expect(text).toContain('the goal itself did not move');
  });
});

/* ------------------------------------------------------------------------- */
/* On real rows, through the operator's own tool                              */
/* ------------------------------------------------------------------------- */

describe('the owner is notified once per verified improvement, the moment Hermes evaluates it', () => {
  const sent: Record<string, unknown>[] = [];
  let projectId = '';

  beforeEach(async () => {
    sent.length = 0;
    factory.status = 'LIVE';
    factory.deployed = true;
    ({ project: { id: projectId } } = await freshProject());
    await createUser({ email: 'owner@example.com', displayName: 'Owner', password: 'correct horse battery staple 1', isBrainAdmin: true });
    vi.stubEnv('INSTANTLY_API_KEY', 'instantly-test-key');
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (String(url).includes('/accounts')) return json({ items: [{ email: 'sender@brain.example', status: 1, warmup_status: 1 }, { email: 'dead@brain.example', status: -1, warmup_status: -1 }] });
      if (String(url).endsWith('/emails/test') && init?.method === 'POST') {
        sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return json({ id: `em_${sent.length}` });
      }
      return new Response('{}', { status: 404 });
    }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function commissionedByHermes(key: string, origin: 'OPERATOR' | 'STANDING_DIRECTOR' = 'OPERATOR'): Promise<string> {
    const run = await startOperatorRun('test-model');
    await finishOperatorRun({ id: run.id, state: 'DONE', summary: 'found it', toolCalls: [{ tool: 'brain_operator_commission', ok: true }], error: null });
    const { candidate } = await upsertCandidate({
      weaknessKey: key,
      kind: 'OPERATOR:RECURRING_OPERATIONAL_FAILURE',
      title: `Moot cards reopen (${key})`,
      problem: 'The goal reads BLOCKED on a person while every open card is moot.',
      metric: 'OWNER_INTERVENTIONS_PER_DAY',
      downstreamMetric: null,
      ownerComponent: 'server/services/russell/needsHuman.ts',
      frequency: 4,
      denominator: 4,
      scope: 'GENERAL',
      severity: 'HIGH',
      evidence: { directive: { origin, runId: run.id, goalId: null, goalTitle: null, deficiency: 'RECURRING_OPERATIONAL_FAILURE', intervention: 'ENGINEERING' } },
    });
    await patchCandidate(candidate.id, { changeRequestId: `fcr_${key}`, campaignId: `fcp_${key}`, deliveredAt: new Date(Date.now() - 60_000).toISOString() });
    return candidate.id;
  }

  async function measuredAndKept(id: string): Promise<void> {
    await decideCandidate(id, 'KEPT', 'owner interventions fell 4 → 1 a day', { result: { before: { value: 4 }, after: { value: 1 }, primary: { verdict: 'IMPROVED' } } });
    await recordImprovementEvent({ candidateId: id, kind: 'DECIDED', detail: { decision: 'KEPT' } });
  }

  async function hermesEvaluates(id: string): Promise<Record<string, unknown>> {
    await startOperatorRun('test-model'); // the evaluating run, RUNNING while it calls the tool
    const { OPERATOR_TOOLS } = await import('../server/mcp/operatorTools.ts');
    const { OPERATOR_SCOPES } = await import('../server/domain/types.ts');
    const principal = {
      type: 'WORKER', id: 'wkr_operator', handle: 'operator', displayName: 'operator', isBrainAdmin: false, mustChangePassword: false,
      credentialId: 'cred_x', authMethod: 'OAUTH_BEARER', requestId: 'req_x',
      memberships: [{ projectId, principalType: 'WORKER', principalId: 'wkr_operator', role: 'MEMBER', scopes: OPERATOR_SCOPES, active: true }],
    } as unknown as import('../server/domain/types.ts').Principal;
    const learn = OPERATOR_TOOLS.find((t) => t.name === 'brain_operator_record_learning')!;
    const out = await learn.run(
      { candidate_id: id, lesson: 'Withdrawing moot cards put the goal back on Brain work: it no longer waits on a person.', evidence: 'goal read again after release' },
      { principal } as never,
    );
    return out.value as Record<string, unknown>;
  }

  it('sends nothing for a release, nothing before Hermes evaluates, then exactly one message', async () => {
    const { notifyVerifiedImprovements } = await import('../server/services/operator/director.ts');
    const id = await commissionedByHermes('OPERATOR:RECURRING_OPERATIONAL_FAILURE:aaaa');

    // Merged, deployed and verified live, not yet measured: a release, not an improvement.
    expect((await notifyVerifiedImprovements())).toEqual([]);
    expect(sent).toHaveLength(0);

    await measuredAndKept(id);
    const before = await notifyVerifiedImprovements();
    expect(before[0]?.status).toBe('NOT_VERIFIED');
    expect(before[0]?.detail).toMatch(/GOAL_EVALUATED/);
    expect(sent).toHaveLength(0);

    const value = await hermesEvaluates(id);
    expect(value['ownerNotice']).toEqual(expect.objectContaining({ status: 'SENT' }));
    expect(sent).toHaveLength(1);
    const mail = sent[0]!;
    expect(mail['eaccount']).toBe('sender@brain.example');
    expect(mail['to_address_email_list']).toBe('owner@example.com');
    expect(String(mail['subject'])).toMatch(/first verified autonomous self-improvement/);
    const body = (mail['body'] as { text: string }).text;
    expect(body).toContain('the software release');
    expect(body).toContain('WHAT ACTUALLY IMPROVED');
    expect(body).toContain('OWNER_INTERVENTIONS_PER_DAY: 4 → 1 (IMPROVED)');

    // Once per improvement, however often the pass or the tool runs again.
    expect((await notifyVerifiedImprovements())[0]?.status).toBe('ALREADY_SENT');
    expect((await hermesEvaluates(id))['ownerNotice']).toMatchObject({ status: 'ALREADY_SENT' });
    expect(sent).toHaveLength(1);
    const events = await getDb().all<{ payload: string }>(`SELECT payload FROM project_events WHERE event_type = 'OWNER_IMPROVEMENT_NOTIFIED'`, []);
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload) as { status: string; release: { verifiedLive: boolean }; improvement: { decision: string } };
    expect(payload.status).toBe('SENT');
    expect(payload.release.verifiedLive).toBe(true);
    expect(payload.improvement.decision).toBe('KEPT');
    expect(await listImprovementEvents({ candidateId: id, kinds: ['OWNER_NOTIFIED'] })).toHaveLength(1);
  });

  it('keeps tracking: the next verified improvement is its own message, numbered', async () => {
    const { notifyVerifiedImprovements } = await import('../server/services/operator/director.ts');
    const first = await commissionedByHermes('OPERATOR:RECURRING_OPERATIONAL_FAILURE:bbbb');
    await measuredAndKept(first);
    await hermesEvaluates(first);
    const second = await commissionedByHermes('OPERATOR:SLOW_ALGORITHM:cccc');
    await measuredAndKept(second);
    await hermesEvaluates(second);
    expect(sent).toHaveLength(2);
    expect(String(sent[1]!['subject'])).toMatch(/verified #2/);
    await notifyVerifiedImprovements();
    expect(sent).toHaveLength(2);
  });

  it("never tells the owner about work Brain's standing director commissioned in Hermes' place", async () => {
    const id = await commissionedByHermes('OPERATOR:RECURRING_OPERATIONAL_FAILURE:dddd', 'STANDING_DIRECTOR');
    await measuredAndKept(id);
    const value = await hermesEvaluates(id);
    expect(value['ownerNotice']).toMatchObject({ status: 'NOT_VERIFIED' });
    expect(sent).toHaveLength(0);
  });
});
