/**
 * An activation nobody can attribute is not a ledger entry.
 *
 * §23 says the capacity ledger is `bin_events` rather than a second table, and
 * that a fire carries `account_id`, `routine_id`, `evidence_class` and
 * `workload_class`. `DISPATCH_ROUTED` did. `DISPATCH_SENT` — the row
 * `workloadProfile` actually counts as an activation — did not, because it was
 * written inside `markDispatchSent` from the dispatch row alone, and a dispatch
 * row knows its bin but not its project, account or class.
 *
 * Production said so plainly. Scoped to Deal Dispatch the profile read
 * `activations: 0` with `perAccount: []`; unscoped it read `activations: 124`
 * with a single `perAccount` entry of `{accountId: null}`. A ledger that
 * records that 124 activations happened and nothing about whose they were
 * cannot answer "which account answered this", which is the question the whole
 * fleet design exists to make answerable.
 *
 * These tests are written against `workloadProfile` rather than against the
 * insert, because the insert being right is not the claim — the claim is that
 * the report can attribute the fire.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { freshProject } from './helpers.ts';
import { createAccount, createRoutine } from '../server/repos/fleet.ts';
import {
  claimDispatchIntent,
  createBin,
  ensureDispatchIntent,
  getBin,
  listBinEvents,
  markDispatchSent,
} from '../server/repos/bins.ts';
import { workloadProfile } from '../server/services/dispatch/profiles.ts';
import type { BinManifest } from '../server/domain/types.ts';

let projectId = '';
let otherProjectId = '';
let accountId = '';
let routineId = '';

beforeEach(async () => {
  const fixture = await freshProject();
  projectId = fixture.project.id;
  const account = await createAccount({ provider: 'anthropic', name: 'ledger-account' });
  accountId = account.id;
  const routine = await createRoutine({
    accountId: account.id,
    routineRef: 'trig_ledger',
    name: 'V-ledger',
    tokenSecretName: 'LEDGER_SECRET',
  });
  routineId = routine.id;
  otherProjectId = '';
});

function manifest(): BinManifest {
  return {
    objective: 'Prove the ledger attributes its own fire.',
    why: 'A fire nobody can attribute is not a ledger entry.',
    lineage: { projectId, layerId: null, goal: null, orchestrationId: null },
    units: [
      { key: 'unit-1', establishes: 'one value', input: 'a value', transform: 'sha256', dependsOn: [] },
    ],
    acceptableSources: [],
    excludedSources: [],
    evidence: ['a stored value matching Brain\u2019s own recomputation'],
    outputs: ['one unit result'],
    authorizedActions: ['submit unit results'],
    prohibitedActions: ['anything with an external effect'],
    budgetUnits: 1,
    retry: { maxAttempts: 3, backoffSeconds: 30 },
    stoppingConditions: ['the declared unit has a verified result'],
  };
}

/** A dispatchable bin, and the intent for it, claimed and ready to be sent. */
async function claimedIntent(options: { workloadClass?: string } = {}) {
  const bin = await createBin({
    projectId,
    kind: 'DETERMINISTIC_CHECK',
    title: 'A bin',
    objective: 'Prove the ledger attributes its own fire',
    completionContract: 'DETERMINISTIC_UNITS_V1',
    manifest: manifest(),
    workloadClass: options.workloadClass ?? 'RUSSELL_TURN',
    createdByType: 'SYSTEM',
    createdById: 'test',
    ready: true,
  });
  await ensureDispatchIntent((await getBin(bin.id))!);
  const intent = await claimDispatchIntent();
  expect(intent).not.toBeNull();
  return { binId: bin.id, intentId: intent!.id };
}

describe('a fire is attributed to the project, account and Routine it was for', () => {
  it('counts as an activation of the project it was fired for', async () => {
    const { intentId } = await claimedIntent();
    await markDispatchSent(intentId, {
      routineRef: 'trig_ledger',
      sessionRef: 'session_one',
      projectId,
      accountId,
      routineId,
      workloadClass: 'RUSSELL_TURN',
    });

    const scoped = await workloadProfile({ projectId });
    expect(scoped.activations).toBe(1);
    expect(scoped.perAccount).toEqual([{ accountId, activations: 1, refusals: 0 }]);
  });

  it('is invisible to a project-scoped report when the attribution is missing', async () => {
    /*
     * The exact regression, stated as a test rather than as a comment. Sent
     * with the old argument shape, the row lands with `project_id` NULL and the
     * scoped profile reads zero — while the unscoped one still counts it, which
     * is what made the defect look like "Deal Dispatch was never dispatched"
     * instead of "the ledger does not record what it was for".
     */
    const { intentId } = await claimedIntent();
    await markDispatchSent(intentId, { routineRef: 'trig_ledger', sessionRef: 'session_two' });

    expect((await workloadProfile({ projectId })).activations).toBe(0);
    expect((await workloadProfile({})).activations).toBe(1);
    expect((await workloadProfile({})).perAccount).toEqual([
      { accountId: null, activations: 1, refusals: 0 },
    ]);
  });

  it('can be read by workload class, which is what a capacity question asks', async () => {
    const { intentId } = await claimedIntent({ workloadClass: 'RUSSELL_TURN' });
    await markDispatchSent(intentId, {
      routineRef: 'trig_ledger',
      projectId,
      accountId,
      routineId,
      workloadClass: 'RUSSELL_TURN',
    });

    expect((await workloadProfile({ workloadClass: 'RUSSELL_TURN' })).activations).toBe(1);
    expect((await workloadProfile({ workloadClass: 'RESEARCH' })).activations).toBe(0);
  });

  it('records the fire as measured rather than as a projection', async () => {
    const { binId, intentId } = await claimedIntent();
    await markDispatchSent(intentId, {
      routineRef: 'trig_ledger',
      projectId,
      accountId,
      routineId,
      workloadClass: 'RUSSELL_TURN',
    });
    const sent = (await listBinEvents(binId)).find((e) => e.eventType === 'DISPATCH_SENT')!;
    expect(sent.evidenceClass).toBe('MEASURED');
    expect(sent.accountId).toBe(accountId);
    expect(sent.routineId).toBe(routineId);
  });

  it('leaves the Routine unnamed rather than guessing when nothing routed', async () => {
    /*
     * The pre-fleet fallback path fires the one configured trigger with no
     * routing decision. There is genuinely no Routine row to name, and filling
     * it in with "the only one there is" would be the ledger inventing
     * attribution — the thing it exists to stop.
     */
    const { binId, intentId } = await claimedIntent();
    await markDispatchSent(intentId, { routineRef: 'trig_env', projectId });
    const sent = (await listBinEvents(binId)).find((e) => e.eventType === 'DISPATCH_SENT')!;
    expect(sent.accountId).toBeNull();
    expect(sent.routineId).toBeNull();
    // And the project is still there, so the fire is at least countable.
    expect((await workloadProfile({ projectId })).activations).toBe(1);
    void otherProjectId;
  });
});
