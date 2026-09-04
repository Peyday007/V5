/**
 * The A11 evaluator, tested from both directions.
 *
 * This is the gate that decides whether Step 12A may be called complete, so the
 * important property is not that it can say yes. It is that it says no to
 * everything short of the real thing, and names *which* thing is short.
 *
 * Each test below builds the complete authentic shape and then removes exactly
 * one part of it. Building the whole shape is not a way around the gate — it is
 * the only way through it, and it is what production has to produce. Removing
 * one part is the shortcut somebody would actually try.
 *
 * Several of them changed direction under the product-owner correction, and
 * they are rewritten rather than deleted so the change stays legible. The
 * requirement used to be two accounts; it is now three distinct authenticated
 * sessions, with stronger tiers preferred, measured and reported truthfully.
 * What used to be a refusal for sharing an account is now a *pass with a
 * weaker reported tier* — and the tests below say so explicitly, because
 * "never label a same-account result as cross-account independent" is the part
 * of the correction that can quietly rot.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { addDocument, freshProject } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createWorker, issueWorkerCredential, setWorkerStatus } from '../server/repos/identity.ts';
import { createAccount, createRoutine } from '../server/repos/fleet.ts';
import { createOrchestration, finishPass, startPass } from '../server/repos/research.ts';
import { createRun } from '../server/repos/runs.ts';
import { auditIndependenceEvidence } from '../server/services/research/independenceEvidence.ts';
import { SIGNED_AUDIT_MATRIX } from '../server/services/research/auditEligibility.ts';

let projectId = '';
let layerId = '';
let fixture: Awaited<ReturnType<typeof freshProject>>;

interface Shape {
  orchestrationId: string;
  workerA: string;
  workerB: string;
  accountA: string;
  accountB: string;
  credentialA: string;
  credentialB: string;
  credentialJudge: string;
}

beforeEach(async () => {
  fixture = await freshProject();
  projectId = fixture.project.id;
  layerId = (await fixture.layerByName('Monetization Logic')).id;
});

function unique(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Everything the gate asks for, assembled honestly.
 *
 * Two accounts holding different credentials, two workers each bound to exactly
 * one of them, three real credentials, three completed audit passes whose
 * lineage agrees with those bindings, and a filed document with bytes.
 *
 * It is deliberately richer than the floor requires. The floor needs three
 * sessions and nothing else, so building more here means the removal tests
 * below are removing something real rather than something the gate never
 * wanted.
 */
async function authenticShape(): Promise<Shape> {
  const workerA = (await createWorker({ name: unique('primary'), createdByType: 'SYSTEM', createdById: 't' })).id;
  const workerB = (await createWorker({ name: unique('adversary'), createdByType: 'SYSTEM', createdById: 't' })).id;

  const accountA = (await createAccount({ name: unique('account-a') })).id;
  const accountB = (await createAccount({ name: unique('account-b') })).id;

  await createRoutine({
    accountId: accountA,
    routineRef: unique('trig'),
    name: 'V1',
    tokenSecretName: 'BRAIN_ROUTINE_TOKEN',
    tokenDigest: unique('digest-a'),
    workerId: workerA,
  });
  await createRoutine({
    accountId: accountB,
    routineRef: unique('trig'),
    name: 'V2',
    tokenSecretName: 'BRAIN_ROUTINE_TOKEN_2',
    tokenDigest: unique('digest-b'),
    workerId: workerB,
  });

  const credentialA = (
    await issueWorkerCredential({ workerId: workerA, issuedByType: 'SYSTEM', issuedById: 't' })
  ).credential.id;
  const credentialB = (
    await issueWorkerCredential({ workerId: workerB, issuedByType: 'SYSTEM', issuedById: 't' })
  ).credential.id;
  // The judge runs on one of the two accounts in a *third* session, which is
  // what the signed matrix asks for and what two accounts can actually supply.
  const credentialJudge = (
    await issueWorkerCredential({ workerId: workerA, issuedByType: 'SYSTEM', issuedById: 't' })
  ).credential.id;

  const run = await createRun({
    projectId,
    layerId,
    runType: 'FOUNDATION',
    provider: 'WORKER',
  });
  const orchestration = await createOrchestration({
    projectId,
    layerId,
    runId: run.id,
    title: 'Independence fixture',
    assignment: 'prove the lineage',
    provider: 'WORKER',
  });

  const roles: [number, string, string, string][] = [
    [5, workerA, accountA, credentialA],
    [6, workerB, accountB, credentialB],
    [7, workerA, accountA, credentialJudge],
  ];
  for (const [ordinal, workerId, accountId, sessionRef] of roles) {
    const pass = await startPass({
      orchestrationId: orchestration.id,
      passKey: 'AUDIT',
      ordinal,
      provider: 'WORKER',
      prompt: 'audit',
      promptSha256: 'x'.repeat(64),
      executorWorkerId: workerId,
      executorAccountId: accountId,
      executorSessionRef: sessionRef,
    });
    await finishPass(pass.id, { status: 'COMPLETE' });
  }

  // Registered through the ordinary path with real bytes on disk, rather than
  // an INSERT: the gate asks whether the packet filed something, and a
  // hand-written row would be testing the gate against a different fact than
  // production produces.
  const document = await addDocument(fixture, 'Monetization Logic', 'v1', { withFile: true });
  await getDb().run(`UPDATE research_orchestrations SET document_id = ? WHERE id = ?`, [
    document.id,
    orchestration.id,
  ]);

  return {
    orchestrationId: orchestration.id,
    workerA,
    workerB,
    accountA,
    accountB,
    credentialA,
    credentialB,
    credentialJudge,
  };
}

describe('A11 passes only on authentic production lineage', () => {
  it('is BLOCKED in an empty Brain, naming the operational fact and not a person', async () => {
    const evidence = await auditIndependenceEvidence();
    expect(evidence.verdict).toBe('BLOCKED');
    // The correction's exact wording. A Brain with nowhere to run an audit has
    // a capacity problem, not an independence problem, and the two have
    // completely different remedies.
    expect(evidence.missing).toMatch(/NO_HEALTHY_EXECUTION_SURFACE/);
    expect(evidence.missing).not.toMatch(/MISSING_FRIEND|DISTINCT_ACCOUNT_CREDENTIALS/);
  });

  it('reaches PASS when every condition is genuinely met', async () => {
    await authenticShape();
    const evidence = await auditIndependenceEvidence();
    expect(evidence.missing).toBeNull();
    expect(evidence.verdict).toBe('PASS');
    // And it says so from rows alone: the same deployed code derives this the
    // moment the second account reconnects, with no further deployment.
    expect(evidence.conditions.every((condition) => condition.met)).toBe(true);
  });
});

describe('A11 refuses every shortcut, and names which one', () => {
  it('passes two account names sharing one credential — and never calls it cross-account', async () => {
    const shape = await authenticShape();
    const digest = await getDb().all<{ token_digest: string }>(
      `SELECT token_digest FROM fleet_routines WHERE account_id = ?`,
      [shape.accountA],
    );
    // The second account re-registers the first one's credential — which is
    // what registering one subscription twice actually looks like.
    await getDb().run(`UPDATE fleet_routines SET token_digest = ? WHERE account_id = ?`, [
      digest[0]!.token_digest,
      shape.accountB,
    ]);

    /*
     * The correction, at its sharpest. Two names on one subscription used to
     * fail the gate; now it passes, because three real sessions ran the three
     * roles and that is what defeats one context reviewing itself. What must
     * never happen is the *report* claiming an account separation the fleet
     * does not have.
     */
    const evidence = await auditIndependenceEvidence();
    expect(evidence.verdict).toBe('PASS');
    expect(evidence.achieved).toBe('SESSION');
    expect(evidence.achieved).not.toBe('ACCOUNT');
  });

  it('passes one worker wearing both accounts, at the weaker tier it earned', async () => {
    const shape = await authenticShape();
    await getDb().run(`UPDATE fleet_routines SET worker_id = ? WHERE account_id = ?`, [
      shape.workerA,
      shape.accountB,
    ]);

    // This is the live fleet's actual shape — one worker bound to two Routines
    // on two accounts. It used to be a hard refusal, which meant the real
    // deployment could never satisfy its own acceptance gate.
    const evidence = await auditIndependenceEvidence();
    expect(evidence.verdict).toBe('PASS');
    expect(evidence.achieved).toBe('SESSION');
    expect(evidence.achieved).not.toBe('WORKER');
  });

  it('does not unmake a finished audit when a worker is disabled afterwards', async () => {
    const shape = await authenticShape();
    await setWorkerStatus(shape.workerB, 'DISABLED');
    /*
     * Revocation takes effect on the next request — §17's rule — and it is not
     * a rewrite of history. Three sessions authenticated and three roles ran;
     * disabling an identity today does not make yesterday's audit not have
     * happened, and reporting otherwise would be the opposite lie to the one
     * this gate exists to prevent.
     */
    const evidence = await auditIndependenceEvidence();
    expect(evidence.verdict).toBe('PASS');
  });

  it('refuses an account label written onto a pass that its worker is not bound to', async () => {
    const shape = await authenticShape();
    // The row now *says* the two arguers were on different accounts. The
    // binding says otherwise, and the binding is what is believed.
    await getDb().run(
      `UPDATE research_passes SET executor_account_id = ? WHERE orchestration_id = ? AND ordinal = 6`,
      [`${shape.accountB}-but-not-really`, shape.orchestrationId],
    );

    const evidence = await auditIndependenceEvidence();
    expect(evidence.verdict).toBe('BLOCKED');
    expect(evidence.missing).toMatch(/LINEAGE_MATCHES_BINDING/);
  });

  it('refuses an invented session reference', async () => {
    const shape = await authenticShape();
    await getDb().run(
      `UPDATE research_passes SET executor_session_ref = ? WHERE orchestration_id = ? AND ordinal = 7`,
      ['wcr_a_session_nobody_issued', shape.orchestrationId],
    );

    const evidence = await auditIndependenceEvidence();
    expect(evidence.verdict).toBe('BLOCKED');
    expect(evidence.missing).toMatch(/SESSIONS_ARE_REAL_CREDENTIALS/);
  });

  it('refuses a session that belongs to a different worker than the pass names', async () => {
    const shape = await authenticShape();
    // A real credential — just not this worker's. The pair has to match, or a
    // fleet could borrow somebody else's session to look separate.
    await getDb().run(
      `UPDATE research_passes SET executor_session_ref = ? WHERE orchestration_id = ? AND ordinal = 5`,
      [shape.credentialB, shape.orchestrationId],
    );

    const evidence = await auditIndependenceEvidence();
    expect(evidence.verdict).toBe('BLOCKED');
    expect(evidence.missing).toMatch(/SESSIONS_ARE_REAL_CREDENTIALS/);
  });

  it('passes both arguments on one account in two sessions', async () => {
    const shape = await authenticShape();
    // Re-point the adversary's whole binding to the primary's account, so the
    // lineage is internally consistent and simply not independent.
    await getDb().run(`UPDATE fleet_routines SET account_id = ? WHERE worker_id = ?`, [
      shape.accountA,
      shape.workerB,
    ]);
    await getDb().run(
      `UPDATE research_passes SET executor_account_id = ? WHERE orchestration_id = ? AND ordinal = 6`,
      [shape.accountA, shape.orchestrationId],
    );

    /*
     * Both arguers on one account, in two different sessions. Under the
     * correction this is exactly the one-account topology that must pass — a
     * single healthy Routine reaching the floor through separate activations —
     * and the reported tier is the honest `SESSION`, never `ACCOUNT`.
     */
    const evidence = await auditIndependenceEvidence();
    expect(evidence.verdict).toBe('PASS');
    expect(evidence.achieved).toBe('SESSION');
  });

  it('refuses a judge that argued', async () => {
    const shape = await authenticShape();
    await getDb().run(
      `UPDATE research_passes SET executor_session_ref = ? WHERE orchestration_id = ? AND ordinal = 7`,
      [shape.credentialA, shape.orchestrationId],
    );

    // The threat itself, and the one thing the correction did not relax: a
    // judge sitting in the session that made one of the arguments is one
    // context reviewing its own work.
    const evidence = await auditIndependenceEvidence();
    expect(evidence.verdict).toBe('BLOCKED');
    expect(evidence.missing).toMatch(/THREE_DISTINCT_SESSIONS/);
    expect(evidence.missing).toMatch(/same session/);
  });

  it('refuses an audit of a packet that filed nothing', async () => {
    const shape = await authenticShape();
    await getDb().run(`UPDATE research_orchestrations SET document_id = NULL WHERE id = ?`, [
      shape.orchestrationId,
    ]);

    const evidence = await auditIndependenceEvidence();
    expect(evidence.verdict).toBe('BLOCKED');
    expect(evidence.missing).toMatch(/AUDITED_PACKET_WAS_FILED/);
  });

  it('refuses a filed document whose bytes are gone', async () => {
    const shape = await authenticShape();
    await getDb().run(
      `UPDATE documents SET file_missing = 1
        WHERE id = (SELECT document_id FROM research_orchestrations WHERE id = ?)`,
      [shape.orchestrationId],
    );

    const evidence = await auditIndependenceEvidence();
    expect(evidence.verdict).toBe('BLOCKED');
    expect(evidence.missing).toMatch(/AUDITED_PACKET_WAS_FILED/);
  });

  it('refuses a pass that never completed', async () => {
    const shape = await authenticShape();
    await getDb().run(
      `UPDATE research_passes SET status = 'FAILED' WHERE orchestration_id = ? AND ordinal = 6`,
      [shape.orchestrationId],
    );

    /*
     * NOT_RUN rather than BLOCKED, and the distinction is the point: the
     * control is intact and a surface exists, so nothing is stopping this —
     * the audit has simply not produced three completed roles. A gate that
     * said BLOCKED here would name no remedy and would invite being weakened
     * to move it.
     */
    const evidence = await auditIndependenceEvidence();
    expect(evidence.verdict).toBe('NOT_RUN');
    expect(evidence.missing).toMatch(/AUDIT_PASSES_RECORDED/);
  });

  it('refuses a predicted session, which is the allocator reasoning and not evidence', async () => {
    const shape = await authenticShape();
    // `future:<routineId>` is how `rankSurfacesFor` reasons about an activation
    // that has not happened. Three of them would look perfectly distinct while
    // nothing had ever authenticated, so final evidence must contain three real
    // session references and this one is refused by name.
    await getDb().run(
      `UPDATE research_passes SET executor_session_ref = ? WHERE orchestration_id = ? AND ordinal = 7`,
      ['future:rtn_not_yet', shape.orchestrationId],
    );

    const evidence = await auditIndependenceEvidence();
    expect(evidence.verdict).toBe('BLOCKED');
    // It fails at the credential check first, which is the stronger statement:
    // a predicted session is not a credential either.
    expect(evidence.missing).toMatch(/SESSIONS_ARE_REAL_CREDENTIALS|SESSIONS_ARE_REAL_ACTIVATIONS/);
  });

  it('refuses a judge that completed before the arguments it was meant to judge', async () => {
    const shape = await authenticShape();
    await getDb().run(
      `UPDATE research_passes SET completed_at = ? WHERE orchestration_id = ? AND ordinal = 7`,
      ['2000-01-01T00:00:00.000Z', shape.orchestrationId],
    );

    // Ordering is part of the contract: the judge may begin only after both
    // arguments are settled and immutable.
    const evidence = await auditIndependenceEvidence();
    expect(evidence.verdict).toBe('BLOCKED');
    expect(evidence.missing).toMatch(/JUDGE_RAN_LAST/);
  });
});

/**
 * The scope filter, which is what stops a historical packet standing in for
 * the mission under acceptance.
 *
 * This is the defect the product owner caught: `A11` passed while `A10`
 * truthfully reported that no Step 12A mission had ever been linked, because
 * the evaluator asked "has *an* audit ever run here" and a Step 10/11 packet
 * answered yes. Scoping is the fix, and these are its teeth.
 */
describe('a historical packet cannot stand in for the scoped mission', () => {
  it('passes when the scope names the orchestration the audit actually ran on', async () => {
    const shape = await authenticShape();
    const evidence = await auditIndependenceEvidence([shape.orchestrationId]);
    expect(evidence.verdict).toBe('PASS');
  });

  it('refuses three genuine sessions that belong to a different mission', async () => {
    const shape = await authenticShape();
    // The audit is real and its lineage is impeccable — it is simply not this
    // mission's audit. That is the whole point.
    const evidence = await auditIndependenceEvidence([`${shape.orchestrationId}-not-this-one`]);
    expect(evidence.verdict).toBe('NOT_RUN');
    expect(evidence.missing).toMatch(/AUDIT_PASSES_RECORDED/);
  });

  it('refuses an empty scope rather than widening to every packet', async () => {
    // A scope that resolved to no orchestration is a different fact from no
    // scope at all, and must never fall back to "search everything".
    await authenticShape();
    const evidence = await auditIndependenceEvidence([]);
    expect(evidence.verdict).toBe('NOT_RUN');
    expect(evidence.missing).toMatch(/no orchestration is in the acceptance scope/);
  });

  it('still searches everything when no scope is given, for the unscoped caller', async () => {
    const shape = await authenticShape();
    expect(shape.orchestrationId).toBeTruthy();
    const evidence = await auditIndependenceEvidence();
    expect(evidence.verdict).toBe('PASS');
  });
});

describe('the gate is evidence for a control that must still exist', () => {
  it('is the corrected minimum, and contains no topology at all', () => {
    /*
     * The floor is session on all three pairs. If somebody *raises* one of
     * these back to ACCOUNT to make the gate stricter, the evaluator's first
     * condition fails and A11 reports BLOCKED rather than PASS — the same
     * protection as before, now pointing the other way. That is deliberate:
     * the minimum is a signed contract in both directions, and a mission that
     * wants more asks for it per mission through `requiredTier`.
     */
    expect(SIGNED_AUDIT_MATRIX['PRIMARY_ADVERSARIAL']).toBe('SESSION');
    expect(SIGNED_AUDIT_MATRIX['JUDGE_PRIMARY']).toBe('SESSION');
    expect(SIGNED_AUDIT_MATRIX['JUDGE_ADVERSARIAL']).toBe('SESSION');
    expect(Object.keys(SIGNED_AUDIT_MATRIX).length).toBe(3);
    // No count of accounts, workers or Routines appears in the minimum.
    expect(Object.values(SIGNED_AUDIT_MATRIX)).not.toContain('ACCOUNT');
  });

  it('reports ROUTINE_SEPARATED rather than collapsing it into SESSION', async () => {
    const shape = await authenticShape();
    /*
     * Three roles, one account, one worker, three Routines. Worker and Routine
     * are not the same tier and must not be treated as equivalent: reporting
     * SESSION here would understate what the fleet achieved, and reporting
     * WORKER would overstate it.
     */
    const routines = await getDb().all<{ id: string }>(
      `SELECT id FROM fleet_routines ORDER BY created_at, rowid`,
    );
    const ordinals = [5, 6, 7];
    for (let index = 0; index < ordinals.length; index += 1) {
      await getDb().run(
        `UPDATE research_passes SET executor_routine_id = ?, executor_account_id = ?
          WHERE orchestration_id = ? AND ordinal = ?`,
        [routines[index]?.id ?? `rtn_extra_${index}`, shape.accountA, shape.orchestrationId, ordinals[index]!],
      );
    }
    // The account column now agrees for all three, so account separation is
    // genuinely absent and only the Routine distinguishes them.
    await getDb().run(`UPDATE fleet_routines SET account_id = ?, worker_id = ?`, [
      shape.accountA,
      shape.workerA,
    ]);
    await getDb().run(`UPDATE research_passes SET executor_worker_id = ? WHERE orchestration_id = ?`, [
      shape.workerA,
      shape.orchestrationId,
    ]);
    // The adversary's session belonged to the other worker, and a session is a
    // credential *of the worker that presented it* — so it gets one of its own
    // rather than borrowing one, which the gate would rightly refuse.
    const thirdSession = (
      await issueWorkerCredential({ workerId: shape.workerA, issuedByType: 'SYSTEM', issuedById: 't' })
    ).credential.id;
    await getDb().run(
      `UPDATE research_passes SET executor_session_ref = ? WHERE orchestration_id = ? AND ordinal = 6`,
      [thirdSession, shape.orchestrationId],
    );

    const evidence = await auditIndependenceEvidence();
    expect(evidence.verdict).toBe('PASS');
    expect(evidence.achieved).toBe('ROUTINE');
  });

  it('exercises the live refusal rather than assuming it', async () => {
    await authenticShape();
    const evidence = await auditIndependenceEvidence();
    const guard = evidence.conditions.find((c) => c.key === 'SAME_LINEAGE_REFUSAL_PRESERVED');
    expect(guard?.met).toBe(true);
    expect(guard?.detail).toMatch(/still refused/);
  });
});
