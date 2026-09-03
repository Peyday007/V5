/**
 * Audit independence, enforced by Brain before work is leased.
 *
 * The signed matrix is two dimensions, not one, and reading it as one is what
 * produced a rule the fleet could never satisfy:
 *
 *   L9   PRIMARY vs ADVERSARIAL  ->  ACCOUNT   ("through different accounts")
 *   L10  JUDGE vs each of them   ->  SESSION   ("same-session lineage refused")
 *
 * Three pairwise-distinct *accounts* is impossible on a two-account fleet and
 * was never asked for. Two accounts and three sessions satisfy this exactly,
 * which is why the live fleet can meet it.
 *
 * Every test below runs against Postgres too when BRAIN_TEST_DATABASE_URL is
 * set. That matters for the concurrency case: SQLite serialises its writers, so
 * two racing claimants there execute one after the other and prove nothing
 * about simultaneity.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createWorker } from '../server/repos/identity.ts';
import { bindRoutineWorker, createAccount, createRoutine } from '../server/repos/fleet.ts';
import { claimWork, enqueueWork, getWorkItem } from '../server/repos/workQueue.ts';
import { createOrchestration } from '../server/repos/research.ts';
import { createRun } from '../server/repos/runs.ts';
import { startPass, finishPass } from '../server/repos/research.ts';
import {
  auditAdmission,
  lineageForWorker,
  accountsEligibleFor,
} from '../server/services/research/auditAdmission.ts';
import {
  auditEligibility,
  auditMatrixVerdict,
  SIGNED_AUDIT_MATRIX,
} from '../server/services/research/auditEligibility.ts';
import type { AuditRole } from '../server/services/queue/workTypes.ts';
import { createHash } from 'node:crypto';
import { TerminalEffectFailure } from '../server/services/effects/engine.ts';
import { toolResultFor } from '../server/mcp/execute.ts';
import {
  envelopeAvailable,
  getApprovalEnvelope,
  STEP11_AUDIT_INDEPENDENCE_ASSIGNMENT,
} from '../server/services/research/approvalEnvelope.ts';
import { createProject } from '../server/repos/projects.ts';
import { recordEvent } from '../server/repos/events.ts';

let projectId = '';
let orchestrationId = '';

/** Two accounts, one bound Routine each — the live shape. */
async function fleet(): Promise<{
  a: { workerId: string; credentialId: string; accountId: string };
  b: { workerId: string; credentialId: string; accountId: string };
}> {
  const one = await createAccount({ name: `one-${Math.random().toString(36).slice(2, 8)}` });
  const two = await createAccount({ name: `two-${Math.random().toString(36).slice(2, 8)}` });
  const wa = await createWorker({ name: `wa-${Math.random().toString(36).slice(2, 8)}`, createdByType: 'SYSTEM', createdById: 't' });
  const wb = await createWorker({ name: `wb-${Math.random().toString(36).slice(2, 8)}`, createdByType: 'SYSTEM', createdById: 't' });
  const ra = await createRoutine({ accountId: one.id, routineRef: `t-a-${one.id}`, name: 'V1', tokenSecretName: 'S1' });
  const rb = await createRoutine({ accountId: two.id, routineRef: `t-b-${two.id}`, name: 'V2', tokenSecretName: 'S2' });
  await bindRoutineWorker(ra.id, wa.id);
  await bindRoutineWorker(rb.id, wb.id);
  return {
    a: { workerId: wa.id, credentialId: 'cred_a1', accountId: one.id },
    b: { workerId: wb.id, credentialId: 'cred_b1', accountId: two.id },
  };
}

/** Record a completed audit pass with an exact lineage. */
async function recordAuditPass(input: {
  role: AuditRole;
  workerId: string;
  routineId: string | null;
  accountId: string | null;
  sessionRef: string | null;
}): Promise<void> {
  const ordinal = input.role === 'PRIMARY' ? 5 : input.role === 'ADVERSARIAL' ? 6 : 7;
  const pass = await startPass({
    orchestrationId,
    fragmentId: null,
    passKey: 'AUDIT',
    ordinal,
    provider: 'WORKER',
    model: input.workerId,
    prompt: 'assignment',
    promptSha256: 'x'.repeat(64),
    executorWorkerId: input.workerId,
    executorRoutineId: input.routineId,
    executorAccountId: input.accountId,
    executorSessionRef: input.sessionRef,
  });
  await finishPass(pass.id, { status: 'COMPLETE', rawResponse: '{}', parsed: {} });
}

async function queueAudit(role: AuditRole): Promise<string> {
  const item = await enqueueWork({
    projectId,
    workType: 'RESEARCH_AUDIT',
    payload: { role },
    orchestrationId,
    createdByType: 'SYSTEM',
    createdById: 'test',
  });
  return item.id;
}

const SCOPES = [{ projectId: '', scopes: ['research:read', 'research:write', 'queue:claim'] }];

async function claimAs(identity: { workerId: string; credentialId: string }) {
  return claimWork({
    admit: auditAdmission(await lineageForWorker(identity)),
    workerId: identity.workerId,
    credentialId: identity.credentialId,
    scopes: [{ projectId, scopes: ['research:read', 'research:write', 'queue:claim'] }],
    workTypes: ['RESEARCH_AUDIT'],
  });
}

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const layerId = fixture.layers[0]!.id;
  const runRow = await createRun({
    projectId,
    layerId,
    runType: 'FOUNDATION',
    status: 'PLANNED',
    provider: 'WORKER',
    prompt: 'A small packet.',
  });
  const orchestration = await createOrchestration({
    projectId,
    layerId,
    runId: runRow.id,
    title: 'A small packet',
    assignment: 'Answer one question.',
    provider: 'WORKER',
    autoApprove: false,
  });
  orchestrationId = orchestration.id;
  void SCOPES;
});

/* ========================================================================= */

describe('the signed matrix', () => {
  it('separates the two arguers by account and the judge by session', () => {
    // Pinned, because the whole defect was reading a two-dimension contract as
    // one. If this changes, it is a policy decision and not a refactor.
    expect(SIGNED_AUDIT_MATRIX).toEqual({
      PRIMARY_ADVERSARIAL: 'ACCOUNT',
      JUDGE_PRIMARY: 'SESSION',
      JUDGE_ADVERSARIAL: 'SESSION',
    });
  });

  it('is satisfiable by two accounts, which is why the live fleet can meet it', async () => {
    const f = await fleet();
    await recordAuditPass({
      role: 'PRIMARY', workerId: f.a.workerId, routineId: null,
      accountId: f.a.accountId, sessionRef: 'sess-1',
    });
    await recordAuditPass({
      role: 'ADVERSARIAL', workerId: f.b.workerId, routineId: null,
      accountId: f.b.accountId, sessionRef: 'sess-2',
    });
    await recordAuditPass({
      // Account A again — permitted, because the judge pairs are separated on
      // session. Requiring a third account would make the contract
      // unsatisfiable here, and it does not ask for one.
      role: 'JUDGE', workerId: f.a.workerId, routineId: null,
      accountId: f.a.accountId, sessionRef: 'sess-3',
    });
    expect(auditMatrixVerdict(await passes()).eligible).toBe(true);
  });

  it('refuses three roles on one account even in three sessions', async () => {
    const f = await fleet();
    for (const [role, sess] of [['PRIMARY', 's1'], ['ADVERSARIAL', 's2'], ['JUDGE', 's3']] as const) {
      await recordAuditPass({
        role, workerId: f.a.workerId, routineId: null,
        accountId: f.a.accountId, sessionRef: sess,
      });
    }
    const verdict = auditMatrixVerdict(await passes());
    expect(verdict.eligible).toBe(false);
    // Exactly one violation: the arguers. The judge pairs are session-separated
    // and legitimately pass.
    expect(verdict.reasons).toHaveLength(1);
    expect(verdict.reasons[0]).toMatch(/PRIMARY and ADVERSARIAL shared the same account\./);
    expect(verdict.reasons[0]).not.toContain(f.a.accountId);
  });

  it('refuses the judge in a session that already argued', async () => {
    const f = await fleet();
    await recordAuditPass({
      role: 'PRIMARY', workerId: f.a.workerId, routineId: null,
      accountId: f.a.accountId, sessionRef: 'shared',
    });
    await recordAuditPass({
      role: 'ADVERSARIAL', workerId: f.b.workerId, routineId: null,
      accountId: f.b.accountId, sessionRef: 'sess-2',
    });
    await recordAuditPass({
      role: 'JUDGE', workerId: f.a.workerId, routineId: null,
      accountId: f.a.accountId, sessionRef: 'shared',
    });
    const verdict = auditMatrixVerdict(await passes());
    expect(verdict.eligible).toBe(false);
    // The pair and the dimension, never the value — a session ref is a
    // credential id, and this reason is read by an untrusted caller.
    expect(verdict.reasons.join(' ')).toMatch(/JUDGE and PRIMARY shared the same session\./);
    expect(verdict.reasons.join(' ')).not.toContain('shared)');
    expect(verdict.conflicts.some((c) => c.value === 'shared')).toBe(true);
  });

  it('fails closed on missing lineage rather than passing it', async () => {
    const f = await fleet();
    await recordAuditPass({
      role: 'PRIMARY', workerId: f.a.workerId, routineId: null,
      accountId: null, sessionRef: 'sess-1',
    });
    await recordAuditPass({
      role: 'ADVERSARIAL', workerId: f.b.workerId, routineId: null,
      accountId: f.b.accountId, sessionRef: 'sess-2',
    });
    const verdict = auditMatrixVerdict(await passes());
    expect(verdict.eligible).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/cannot be compared: one recorded no account/);
  });
});

async function passes() {
  const { listPasses } = await import('../server/repos/research.ts');
  return listPasses(orchestrationId);
}

/* ========================================================================= */

describe('eligibility is decided before the lease', () => {
  it('refuses the same account for the second arguer, and consumes no attempt', async () => {
    const f = await fleet();
    await recordAuditPass({
      role: 'PRIMARY', workerId: f.a.workerId, routineId: null,
      accountId: f.a.accountId, sessionRef: 'sess-1',
    });
    const itemId = await queueAudit('ADVERSARIAL');

    const before = await getWorkItem(itemId);
    const claimed = await claimAs({ workerId: f.a.workerId, credentialId: 'cred_a2' });
    const after = await getWorkItem(itemId);

    expect(claimed).toHaveLength(0);
    // The whole point of admitting before the compare-and-swap: nothing moved.
    expect(after!.attemptCount).toBe(before!.attemptCount);
    expect(after!.state).toBe('QUEUED');
    expect(after!.leaseGeneration).toBe(before!.leaseGeneration);
  });

  it('lets the eligible surface claim it immediately afterwards', async () => {
    const f = await fleet();
    await recordAuditPass({
      role: 'PRIMARY', workerId: f.a.workerId, routineId: null,
      accountId: f.a.accountId, sessionRef: 'sess-1',
    });
    await queueAudit('ADVERSARIAL');

    expect(await claimAs({ workerId: f.a.workerId, credentialId: 'cred_a2' })).toHaveLength(0);
    const claimed = await claimAs(f.b);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.workType).toBe('RESEARCH_AUDIT');
  });

  it('refuses the judge from a session that already ran a role', async () => {
    const f = await fleet();
    await recordAuditPass({
      role: 'PRIMARY', workerId: f.a.workerId, routineId: null,
      accountId: f.a.accountId, sessionRef: 'cred_a1',
    });
    await recordAuditPass({
      role: 'ADVERSARIAL', workerId: f.b.workerId, routineId: null,
      accountId: f.b.accountId, sessionRef: 'cred_b1',
    });
    const itemId = await queueAudit('JUDGE');

    // The same session as the primary.
    expect(await claimAs({ workerId: f.a.workerId, credentialId: 'cred_a1' })).toHaveLength(0);
    expect((await getWorkItem(itemId))!.attemptCount).toBe(0);
    // A new session on the same account is fine — the judge pairs are separated
    // on session, not account.
    expect(await claimAs({ workerId: f.a.workerId, credentialId: 'cred_a9' })).toHaveLength(1);
  });

  it('refuses a worker with no resolvable account, rather than admitting it', async () => {
    const f = await fleet();
    await recordAuditPass({
      role: 'PRIMARY', workerId: f.a.workerId, routineId: null,
      accountId: f.a.accountId, sessionRef: 'sess-1',
    });
    await queueAudit('ADVERSARIAL');
    const stranger = await createWorker({ name: `ws-${Math.random().toString(36).slice(2, 8)}`, createdByType: 'SYSTEM', createdById: 't' });
    // Bound to no Routine, so no account can be resolved. Unknown lineage is a
    // violation, never a pass.
    expect(await claimAs({ workerId: stranger.id, credentialId: 'cred_x' })).toHaveLength(0);
  });

  it('leaves non-audit work alone', async () => {
    const f = await fleet();
    await recordAuditPass({
      role: 'PRIMARY', workerId: f.a.workerId, routineId: null,
      accountId: f.a.accountId, sessionRef: 'sess-1',
    });
    await enqueueWork({
      projectId,
      workType: 'RESEARCH_VERIFY',
      payload: { fragment_key: 'f1' },
      orchestrationId,
      createdByType: 'SYSTEM',
      createdById: 'test',
    });
    // The very surface refused for the adversarial role may still drain this.
    const claimed = await claimWork({
      admit: auditAdmission(await lineageForWorker({ workerId: f.a.workerId, credentialId: 'cred_a2' })),
      workerId: f.a.workerId,
      credentialId: 'cred_a2',
      scopes: [{ projectId, scopes: ['research:read', 'research:write', 'queue:claim'] }],
      workTypes: ['RESEARCH_VERIFY'],
    });
    expect(claimed).toHaveLength(1);
  });

  it('cannot be defeated by two claimants racing for one role', async () => {
    // Genuinely concurrent on Postgres. Both are eligible, so the rule is not
    // what stops the second — the compare-and-swap is — and the point is that
    // admitting before the swap does not open a second window into it.
    const f = await fleet();
    await recordAuditPass({
      role: 'PRIMARY', workerId: f.a.workerId, routineId: null,
      accountId: f.a.accountId, sessionRef: 'sess-1',
    });
    const itemId = await queueAudit('ADVERSARIAL');
    const [first, second] = await Promise.all([
      claimAs({ ...f.b, credentialId: 'cred_b1' }),
      claimAs({ ...f.b, credentialId: 'cred_b2' }),
    ]);
    expect(first.length + second.length).toBe(1);
    expect((await getWorkItem(itemId))!.attemptCount).toBe(1);
  });

  it('names which accounts could still take the waiting role', async () => {
    const f = await fleet();
    await recordAuditPass({
      role: 'PRIMARY', workerId: f.a.workerId, routineId: null,
      accountId: f.a.accountId, sessionRef: 'sess-1',
    });
    const eligible = await accountsEligibleFor({ orchestrationId, role: 'ADVERSARIAL' });
    // Only the other account. This is what stops the dispatcher firing the
    // surface that cannot take it, over and over.
    expect(eligible).toEqual([f.b.accountId]);
  });
});

/* ========================================================================= */

describe('a refusal is a result, not an opaque failure', () => {
  it('never puts an identifier in a caller-facing reason', async () => {
    /*
     * The session dimension *is* the credential the request authenticated with,
     * so a reason reading "shared the same session (cred_…)" would hand a
     * credential identifier to an untrusted caller inside a refusal. The pair
     * and the dimension are everything the caller needs to act; the value stays
     * in `conflicts`, which Brain logs and never returns.
     */
    const f = await fleet();
    await recordAuditPass({
      role: 'PRIMARY', workerId: f.a.workerId, routineId: null,
      accountId: f.a.accountId, sessionRef: 'cred_secret_value',
    });
    await recordAuditPass({
      role: 'ADVERSARIAL', workerId: f.b.workerId, routineId: null,
      accountId: f.b.accountId, sessionRef: 'cred_other',
    });
    await recordAuditPass({
      role: 'JUDGE', workerId: f.a.workerId, routineId: null,
      accountId: f.a.accountId, sessionRef: 'cred_secret_value',
    });
    const verdict = auditMatrixVerdict(await passes());
    expect(verdict.eligible).toBe(false);
    const text = verdict.reasons.join(' ');
    expect(text).toMatch(/shared the same session/);
    expect(text).not.toContain('cred_secret_value');
    expect(text).not.toContain(f.a.accountId);
    // Brain still knows, for its own log.
    expect(verdict.conflicts.some((c) => c.value === 'cred_secret_value')).toBe(true);
  });

  it('maps an effect refusal onto the protocol category rather than UNAVAILABLE', () => {
    /*
     * `TerminalEffectFailure` is Step 6's vocabulary and is not a `ToolError`,
     * so every one of them used to fall through to the internal-error blanket
     * and reach the caller as `UNAVAILABLE: "That call could not be
     * completed."` — a policy refusal disguised as a Brain fault, which a
     * worker would retry forever against a rule that will never let it through.
     *
     * The two vocabularies stay separate: `NOT_AUTHORIZED` is an effect
     * category and `TOOL_ERROR_CATEGORIES` is the protocol's closed set, so the
     * effect category is mapped to `NOT_PERMITTED` and carried verbatim in the
     * detail under `policy`.
     */
    const body = toolResultFor(
      new TerminalEffectFailure('NOT_AUTHORIZED', 'The audit lineage does not satisfy the matrix.'),
    );
    expect(body).not.toBeNull();
    const error = (body!.structuredContent as { error: Record<string, unknown> }).error;
    expect(error['category']).toBe('NOT_PERMITTED');
    expect(error['policy']).toBe('NOT_AUTHORIZED');
    expect(error['message']).toMatch(/does not satisfy the matrix/);
    expect(body!.isError).toBe(true);
  });

  it('keeps an internal error opaque', () => {
    // The blanket still exists and still catches the case it was written for:
    // an internal message may carry a path or a SQL fragment, and none of that
    // is the caller's.
    expect(
      toolResultFor(new TerminalEffectFailure('INTERNAL_ERROR', 'sqlite: /data/brain.db is locked')),
    ).toBeNull();
  });
});

describe('the one-use envelope', () => {
  it('authorizes exactly the assignment it pins, and nothing else', () => {
    const envelope = getApprovalEnvelope('STEP11_AUDIT_INDEPENDENCE_V1');
    expect(envelope).not.toBeNull();
    expect(envelope!.oneUse).toBe(true);
    expect(envelope!.projectSlug).toBe('step-11-acceptance');
    expect(envelope!.maxFragments).toBe(1);
    // The exact text, by digest. A packet whose question drifted by one word is
    // not the packet that was authorized.
    expect(envelope!.assignmentSha256).toBe(
      createHash('sha256').update(STEP11_AUDIT_INDEPENDENCE_ASSIGNMENT, 'utf8').digest('hex'),
    );
    // Delaware only, and every other state refused by construction.
    expect(envelope!.geography.test('delaware')).toBe(true);
    expect(envelope!.forbiddenScope.test('michigan')).toBe(true);
    expect(envelope!.forbiddenScope.test('federal')).toBe(true);
    // No secondary source may support a claim.
    expect(envelope!.allowedSourceTypes.test('law firm article')).toBe(false);
    expect(envelope!.allowedSourceTypes.test('Delaware Code')).toBe(true);
  });

  it('refuses a second packet once the authorization is spent', async () => {
    const project = await createProject({ name: 'S11 acceptance', slug: 'step-11-acceptance' });
    const envelope = getApprovalEnvelope('STEP11_AUDIT_INDEPENDENCE_V1')!;

    const first = await envelopeAvailable({
      envelope, projectId: project.id, projectSlug: project.slug, orchestrationId: 'orc_first',
    });
    expect(first.available).toBe(true);

    // The approval that spends it, written the way the runner writes it.
    await recordEvent({
      projectId: project.id,
      layerId: null,
      entityType: 'RUN',
      entityId: 'run_x',
      eventType: 'RESEARCH_PLAN_SYSTEM_APPROVED',
      payload: { orchestrationId: 'orc_first', envelopeId: 'STEP11_AUDIT_INDEPENDENCE_V1' },
    });

    const second = await envelopeAvailable({
      envelope, projectId: project.id, projectSlug: project.slug, orchestrationId: 'orc_second',
    });
    expect(second.available).toBe(false);
    expect(second.reasons.join(' ')).toMatch(/one-use authorization and it was already spent/);
    // And the same packet is still allowed to be re-advanced.
    const again = await envelopeAvailable({
      envelope, projectId: project.id, projectSlug: project.slug, orchestrationId: 'orc_first',
    });
    expect(again.available).toBe(true);
  });

  it('refuses to approve inside a project it was not scoped to', async () => {
    const elsewhere = await createProject({ name: 'Real research', slug: 'deal-dispatch-x' });
    const envelope = getApprovalEnvelope('STEP11_AUDIT_INDEPENDENCE_V1')!;
    const verdict = await envelopeAvailable({
      envelope, projectId: elsewhere.id, projectSlug: elsewhere.slug, orchestrationId: 'orc_a',
    });
    expect(verdict.available).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/must not approve a plan in a project holding real research/);
  });
});

describe('the guards are load-bearing', () => {
  it('would admit the conflicting claim if the account rule were dropped', async () => {
    // The inversion, expressed as the rule rather than by editing the source:
    // with PRIMARY_ADVERSARIAL relaxed to SESSION, the same account in a new
    // session becomes eligible — which is exactly the weakening the contract
    // forbids, and exactly what the test above would stop noticing.
    const f = await fleet();
    await recordAuditPass({
      role: 'PRIMARY', workerId: f.a.workerId, routineId: null,
      accountId: f.a.accountId, sessionRef: 'sess-1',
    });
    const executor = {
      workerId: f.a.workerId, routineId: null,
      accountId: f.a.accountId, sessionRef: 'sess-9',
    };
    const signed = auditEligibility({ role: 'ADVERSARIAL', executor, passes: await passes() });
    expect(signed.eligible).toBe(false);
    expect(signed.applied.some((a) => a.pair === 'PRIMARY_ADVERSARIAL' && a.level === 'ACCOUNT')).toBe(true);
  });

  it('would admit a same-session judge if the session rule were dropped', async () => {
    const f = await fleet();
    await recordAuditPass({
      role: 'PRIMARY', workerId: f.a.workerId, routineId: null,
      accountId: f.a.accountId, sessionRef: 'sess-1',
    });
    await recordAuditPass({
      role: 'ADVERSARIAL', workerId: f.b.workerId, routineId: null,
      accountId: f.b.accountId, sessionRef: 'sess-2',
    });
    const executor = {
      workerId: f.a.workerId, routineId: null,
      accountId: f.a.accountId, sessionRef: 'sess-1',
    };
    const signed = auditEligibility({ role: 'JUDGE', executor, passes: await passes() });
    expect(signed.eligible).toBe(false);
    expect(signed.applied.some((a) => a.pair === 'JUDGE_PRIMARY' && a.level === 'SESSION')).toBe(true);
  });

  it('records the four lineage columns, or the matrix has nothing to read', async () => {
    const f = await fleet();
    await recordAuditPass({
      role: 'PRIMARY', workerId: f.a.workerId, routineId: 'rtn_x',
      accountId: f.a.accountId, sessionRef: 'sess-1',
    });
    const [pass] = await passes();
    expect(pass!.executorWorkerId).toBe(f.a.workerId);
    expect(pass!.executorRoutineId).toBe('rtn_x');
    expect(pass!.executorAccountId).toBe(f.a.accountId);
    expect(pass!.executorSessionRef).toBe('sess-1');
    void getDb;
  });
});
