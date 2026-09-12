/**
 * The six Capability Lab acceptance runs §29 G requires, run for real.
 *
 *   1. one Health Check
 *   2. one Calibration Run
 *   3. one Work-Layout Tournament comparing at least two materially different
 *      layouts
 *   4. one bounded Push-to-Failure test
 *   5. one failure/recovery drill
 *   6. one apply-as-canary → retest → compare → rollback cycle
 *
 * Every one of them executes. Nothing here is projected, simulated, or
 * described-instead-of-done — and the reason that is possible is the
 * correction `labRunners.ts` records: the pressure these modes apply is to
 * Brain's own concurrency machinery, which runs here and costs nothing, rather
 * than to a provider, which would cost the subscription.
 *
 * ---------------------------------------------------------------------------
 * The envelope this runs inside, stated before it runs
 * ---------------------------------------------------------------------------
 *
 *  - **Scope.** A `TECHNICAL` project created by this script and dropped from
 *    ordinary views by provenance. `declareExperiment` refuses a pressure mode
 *    anywhere else.
 *  - **Work.** `SYNTHETIC_ECHO` only, which touches no document, claim, audit
 *    or knowledge row, and is declared `HARMLESS` at registration.
 *  - **Claimants.** Worker identities this script registers *in that scope
 *    only*, with `queue:claim` and nothing else.
 *  - **Spend.** Zero. No Routine is fired, no token is presented to any
 *    provider, `max_external_spend` is untouched, and no paid model path is
 *    reachable from here.
 *  - **Concurrency.** Bounded by each experiment's declared ceiling and again
 *    by `MAX_CONCURRENCY` in code.
 *  - **Cleanup.** Each drain cancels whatever it did not finish, which advances
 *    the fencing generation, so nothing it created can land afterwards.
 *  - **Rollback.** The canary cycle sets a fleet policy and rolls it back to
 *    the named prior version, both as ordinary `fleet_policy` rows.
 *
 * Run it locally or against a copy. It is not a production operation and does
 * not need to be one: what it proves is that the Lab's modes work, and that is
 * a property of the code rather than of any particular fleet.
 *
 *   npx tsx scripts/step12b-lab.ts
 */
import { initDatabase, getDb, closeDatabase } from '../server/db/database.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createProject } from '../server/repos/projects.ts';
import { createWorker, grantMembership } from '../server/repos/identity.ts';
import { currentPolicy } from '../server/repos/fleet.ts';
import {
  DEFAULT_TARGET_WITH_NO_PRIOR_POLICY,
  applyFinding,
  declareExperiment,
  getExperiment,
  rollbackFinding,
  runExperiment,
  type LabExperiment,
  type LabMode,
  type TestEnvelope,
} from '../server/services/fleet/lab.ts';

const ACTOR = 'step12b-lab';

/** One envelope shape for every pressure run, so the bounds are visible once. */
function envelope(overrides: Partial<TestEnvelope> = {}): TestEnvelope {
  return {
    ceiling: 4,
    durationMinutes: 1,
    stopConditions: ['the declared ceiling is reached', 'the duration runs out'],
    cleanup: 'cancel every synthetic item the run did not finish',
    rollback: 'nothing is applied unless the canary step applies it, which is reversed',
    workloadClass: 'SYNTHETIC',
    workKind: 'SYNTHETIC',
    ...overrides,
  };
}

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(24)} ${value}`);
}

function report(run: LabExperiment): void {
  console.log('');
  console.log(`${run.mode}  ${run.state}`);
  if (run.refusalReason) {
    line('refused', run.refusalReason);
    return;
  }
  const result = run.result;
  if (!result) {
    line('result', 'none — nothing was measured');
    return;
  }
  line('tested', result.whatWasTested);
  line('happened', result.whatHappened);
  line('degradation began', `${result.degradationBegan.value} [${result.degradationBegan.evidence}]`);
  line('bottleneck', `${result.bottleneck.value} [${result.bottleneck.evidence}]`);
  line('recommended', `${result.recommendedSetting.value} [${result.recommendedSetting.evidence}]`);
  line(
    'highest tested',
    `${result.highestTested.value ?? 'none'}${result.highestTested.anythingFailed ? ' (something failed)' : ' (nothing failed there)'}`,
  );
  line('sample size', String(result.confidence.sampleSize));
  for (const finding of result.findings) line('finding', finding);
  for (const untested of result.untested) line('NOT tested', untested);
}

async function run(
  projectId: string,
  mode: LabMode,
  title: string,
  overrides: Partial<TestEnvelope> = {},
): Promise<LabExperiment> {
  const declared = await declareExperiment({
    projectId,
    mode,
    title,
    envelope: envelope(overrides),
    actor: ACTOR,
  });
  if (declared.state === 'REFUSED') {
    report(declared);
    return declared;
  }
  // `pressureAuthorized` is supplied here, by this script, which is the
  // authorization: running it is the act of authorizing it, and the envelope
  // above is what is being authorized. An experiment can never authorize
  // itself — see `runExperiment`.
  const ran = await runExperiment({ id: declared.id, pressureAuthorized: true });
  report(ran);
  return ran;
}

async function main(): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-lab-'));
  await initDatabase({ dbPath: path.join(dataDir, 'lab.db') });

  const project = await createProject({
    name: 'Step 12B Lab acceptance',
    slug: `step12b-lab-${Date.now()}`,
    purpose: 'TECHNICAL',
  });

  // Two claimant identities: one is enough to drain, and two are what make the
  // recovery drill's cross-identity takeover a true statement rather than a
  // rounded-up one.
  for (const suffix of ['a', 'b']) {
    const worker = await createWorker({
      name: `lab-claimant-${suffix}-${Date.now()}`,
      createdByType: 'SYSTEM',
      createdById: ACTOR,
    });
    await grantMembership({
      projectId: project.id,
      principalType: 'WORKER',
      principalId: worker.id,
      scopes: ['queue:claim'],
      grantedByType: 'SYSTEM',
      grantedById: ACTOR,
    });
  }

  console.log('STEP 12B — Capability Lab acceptance');
  console.log(`  isolated scope           ${project.id} (TECHNICAL)`);
  console.log('  spend                    zero: no Routine is fired and no provider is called');
  console.log('');

  const results: { name: string; run: LabExperiment }[] = [];

  results.push({ name: '1. Health Check', run: await run(project.id, 'HEALTH_CHECK', 'Is the fleet able to run anything?') });
  results.push({ name: '2. Calibration', run: await run(project.id, 'CALIBRATION', 'What has this fleet actually done?') });
  results.push({
    name: '3. Layout tournament',
    run: await run(project.id, 'LAYOUT_TOURNAMENT', 'One at a time against batched, over identical work'),
  });
  const push = await run(project.id, 'PUSH_TO_FAILURE', 'How many claimants before contention stops paying?', {
    ceiling: 8,
  });
  results.push({ name: '4. Push to failure', run: push });
  results.push({
    name: '5. Recovery drill',
    run: await run(project.id, 'RECOVERY_DRILL', 'A worker disappears mid-lease', { ceiling: 1 }),
  });
  // The two remaining modes are run as well, because §29 G's six are a minimum
  // rather than permission to skip the rest.
  results.push({
    name: '   One-Routine fit',
    run: await run(project.id, 'ONE_ROUTINE_FIT', 'How much does one lane hold?', { ceiling: 4 }),
  });
  results.push({
    name: '   Quality under pressure',
    run: await run(project.id, 'QUALITY_UNDER_PRESSURE', 'Does quality go before speed?', { ceiling: 6 }),
  });
  results.push({
    name: '   Fleet and provider',
    run: await run(project.id, 'FLEET_PROVIDER', 'What does the ledger say about the fleet?'),
  });

  /* ------------------------------------------------------------------------
   * 6. Apply as canary, retest, compare, roll back.
   *
   * The whole cycle against real `fleet_policy` rows: a recommendation becomes
   * a policy, the same test runs again under it, the two results are compared,
   * and the policy is returned to the version it displaced. Policy is rows
   * (§23), so the rollback target is a row that is still there rather than a
   * number this script remembered.
   * --------------------------------------------------------------------- */
  console.log('');
  console.log('6. Canary cycle: apply -> retest -> compare -> roll back');

  const before = await currentPolicy('FLEET', null);
  line('policy before', before ? `v${before.version} target=${before.target}` : 'none set');

  const canaryTarget = push.result?.highestTested.value ?? 2;
  const applied = await applyFinding({
    experimentId: push.id,
    target: canaryTarget,
    actor: ACTOR,
    reason: 'Canary: adopt the concurrency the push test reached',
  });
  const afterApply = await currentPolicy('FLEET', null);
  line('applied', `v${afterApply?.version} target=${afterApply?.target} (policy ${applied.appliedPolicyId})`);

  const retest = await run(project.id, 'PUSH_TO_FAILURE', 'Retest under the canary policy', {
    ceiling: 8,
  });
  const firstRate = push.result?.confidence.sampleSize ?? 0;
  const secondRate = retest.result?.confidence.sampleSize ?? 0;
  line(
    'compared',
    `first run drained ${firstRate}, retest drained ${secondRate} — ` +
      (secondRate >= firstRate ? 'no regression under the canary' : 'the retest drained less'),
  );

  const rolledBack = await rollbackFinding({
    experimentId: push.id,
    actor: ACTOR,
    reason: 'Canary complete; returning the fleet to its previous target',
  });
  const afterRollback = await currentPolicy('FLEET', null);
  line(
    'displaced',
    rolledBack.displacedPolicyId
      ? `policy ${rolledBack.displacedPolicyId} target=${rolledBack.displacedTarget}`
      : 'nothing — there was no prior policy',
  );
  line(
    'rolled back',
    `v${afterRollback?.version} target=${afterRollback?.target}, rolled_back_at=${rolledBack.rolledBackAt}`,
  );

  /*
   * The rollback has to actually undo the canary.
   *
   * Checked rather than reported, and checked in both directions: with a prior
   * policy it must return to that target, and with none it must return to the
   * default rather than keeping the canary's number. The second case is the one
   * that was silently broken, and this run is what found it.
   */
  const expected = before ? before.target : DEFAULT_TARGET_WITH_NO_PRIOR_POLICY;
  if (afterRollback && afterRollback.target !== expected) {
    console.error(
      `LAB: FAILED rollback should have returned the target to ${expected}; it is ${afterRollback.target}`,
    );
    process.exit(1);
  }
  if (afterRollback && afterRollback.target === canaryTarget && canaryTarget !== expected) {
    console.error('LAB: FAILED the rollback kept the canary value');
    process.exit(1);
  }

  /* ------------------------------------------------------------------------
   * The verdict, and what it does not say.
   * --------------------------------------------------------------------- */
  console.log('');
  console.log('--- what ran ---');
  let complete = 0;
  for (const entry of results) {
    const ok = entry.run.state === 'COMPLETE';
    if (ok) complete += 1;
    console.log(`  ${entry.name.padEnd(26)} ${entry.run.state}`);
  }
  console.log(`  ${'   Canary retest'.padEnd(26)} ${retest.state}`);

  // Nothing here reached a provider, and the report says so every time rather
  // than once: a reader who skipped the header must still not be able to read
  // this as a statement about Cowork capacity.
  console.log('');
  console.log('This measured Brain\'s own concurrency machinery. It says nothing about how much');
  console.log('a real Cowork surface holds — that needs real activations, it spends the');
  console.log('subscription, and it is the one thing here a person must authorize separately.');

  const experiments = await getDb().all<{ total: number }>(
    'SELECT COUNT(*) AS total FROM capability_experiments WHERE project_id = ?',
    [project.id],
  );
  console.log('');
  console.log(
    `LAB: OK ${complete}/${results.length} modes complete, ` +
      `${Number(experiments[0]?.total ?? 0)} experiments recorded, canary applied and rolled back`,
  );

  await closeDatabase();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
