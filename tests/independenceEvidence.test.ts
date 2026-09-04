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
  it('is BLOCKED in an empty Brain, naming the first thing that is missing', async () => {
    const evidence = await auditIndependenceEvidence();
    expect(evidence.verdict).toBe('BLOCKED');
    expect(evidence.missing).toMatch(/DISTINCT_ACCOUNT_CREDENTIALS/);
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
  it('refuses two account names sharing one credential', async () => {
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

    const evidence = await auditIndependenceEvidence();
    expect(evidence.verdict).toBe('BLOCKED');
    expect(evidence.missing).toMatch(/DISTINCT_ACCOUNT_CREDENTIALS/);
    expect(evidence.missing).toMatch(/share one credential/);
  });

  it('refuses one worker wearing both accounts', async () => {
    const shape = await authenticShape();
    await getDb().run(`UPDATE fleet_routines SET worker_id = ? WHERE account_id = ?`, [
      shape.workerA,
      shape.accountB,
    ]);

    const evidence = await auditIndependenceEvidence();
    expect(evidence.verdict).toBe('BLOCKED');
    expect(evidence.missing).toMatch(/DISTINCT_BOUND_WORKERS/);
  });

  it('refuses a disabled worker identity', async () => {
    const shape = await authenticShape();
    await setWorkerStatus(shape.workerB, 'DISABLED');
    const evidence = await auditIndependenceEvidence();
    expect(evidence.verdict).toBe('BLOCKED');
    expect(evidence.missing).toMatch(/DISTINCT_BOUND_WORKERS/);
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

  it('refuses both arguments on one account', async () => {
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

    const evidence = await auditIndependenceEvidence();
    expect(evidence.verdict).toBe('BLOCKED');
    // It fails at the earlier condition, which is the honest one: with both
    // Routines on one account there are no longer two accounts to argue.
    expect(evidence.missing).toMatch(/DISTINCT_ACCOUNT_CREDENTIALS|DISTINCT_BOUND_WORKERS|INDEPENDENT_LINEAGE/);
  });

  it('refuses a judge that argued', async () => {
    const shape = await authenticShape();
    await getDb().run(
      `UPDATE research_passes SET executor_session_ref = ? WHERE orchestration_id = ? AND ordinal = 7`,
      [shape.credentialA, shape.orchestrationId],
    );

    const evidence = await auditIndependenceEvidence();
    expect(evidence.verdict).toBe('BLOCKED');
    expect(evidence.missing).toMatch(/INDEPENDENT_LINEAGE/);
    expect(evidence.missing).toMatch(/also argued/);
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

    const evidence = await auditIndependenceEvidence();
    expect(evidence.verdict).toBe('BLOCKED');
    expect(evidence.missing).toMatch(/AUDIT_PASSES_RECORDED/);
  });
});

describe('the gate is evidence for a control that must still exist', () => {
  it('is the signed matrix, not a weaker one', () => {
    // If somebody lowers PRIMARY_ADVERSARIAL to SESSION to make an audit
    // eligible, the evaluator's first condition fails and A11 reports BLOCKED
    // rather than PASS. This asserts the shape it compares against.
    expect(SIGNED_AUDIT_MATRIX['PRIMARY_ADVERSARIAL']).toBe('ACCOUNT');
    expect(SIGNED_AUDIT_MATRIX['JUDGE_PRIMARY']).toBe('SESSION');
    expect(SIGNED_AUDIT_MATRIX['JUDGE_ADVERSARIAL']).toBe('SESSION');
    expect(Object.keys(SIGNED_AUDIT_MATRIX).length).toBe(3);
  });

  it('exercises the live refusal rather than assuming it', async () => {
    await authenticShape();
    const evidence = await auditIndependenceEvidence();
    const guard = evidence.conditions.find((c) => c.key === 'SAME_LINEAGE_REFUSAL_PRESERVED');
    expect(guard?.met).toBe(true);
    expect(guard?.detail).toMatch(/still refused/);
  });
});
