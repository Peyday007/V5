/**
 * After a buyer agrees: an obligation carried through delivery, acceptance,
 * costs, refunds and what it taught — without lying about any of them.
 *
 * Every journey drives the real service against the real repositories and the
 * real ledger. What is simulated is the outside world only: the Factory
 * campaign finishing (a patched campaign row, as `workRegister` does), a
 * research mission filing (mission rows, as `cashOperate` does), and a refund
 * provider (a registered effect adapter, as `cashBrainEffects` does).
 *
 * The assertions that matter most are absences: no second piece of work, no
 * second money entry, no completion while anything is outstanding, and no
 * refund sent twice.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { freshProject, restartDatabase } from './helpers.ts';
import { getDb } from '../server/db/database.ts';
import { createUser } from '../server/repos/identity.ts';
import { createAuthority } from '../server/repos/cashAuthority.ts';
import { recordCardFact } from '../server/repos/cashCardFacts.ts';
import { getOpportunity, listNeeds } from '../server/repos/cashPortfolio.ts';
import { activate } from '../server/services/cash/lifecycle.ts';
import { ALWAYS_PROHIBITED_COMMERCIAL, COMMERCIAL_ACTIONS } from '../server/services/cash/authority.ts';
import {
  actionKey,
  beginExecution,
  capture,
  fillCard,
  markReady,
  recordMoneyEvent,
} from '../server/services/cash/opportunities.ts';
import { CAPTURE_KEY, qualificationKeys } from '../server/services/cash/tier.ts';
import { cashPosition } from '../server/services/cash/money.ts';
import { closeNeed } from '../server/services/cash/needs.ts';
import {
  advanceFulfillment,
  answerRefund,
  authorizeRefund,
  declare,
  outcomeLessons,
  readFulfillment,
  recordCost,
  recordEvent,
} from '../server/services/cash/fulfillment.ts';
import { readCapability } from '../server/services/cash/capabilities.ts';
import { REFUND_NAMESPACE } from '../server/services/cash/effects.ts';
import { clearAdapters, registerAdapter, type SendOutcome } from '../server/services/effects/adapter.ts';
import { approveObjective, submitObjective } from '../server/services/factory/contract.ts';
import {
  ensureCampaign,
  factoryNow,
  getCampaignByChangeRequest,
  listChangeRequests,
  patchCampaign,
} from '../server/repos/factory.ts';
import { fulfillmentForOpportunity, listObservations } from '../server/repos/cashFulfillment.ts';
import { launchMission, linkMission, transitionMission } from '../server/repos/russellMissions.ts';
import { getCandidate } from '../server/repos/russellCandidates.ts';

const exec = promisify(execFile);

let projectId = '';
let userId = '';
let repoRoot = '';
let layerId = '';

beforeEach(async () => {
  clearAdapters();
  const fixture = await freshProject();
  projectId = fixture.project.id;
  layerId = (await fixture.layerByName('Discovery Logic')).id;
  const user = await createUser({
    email: `fulfil-${Math.random().toString(36).slice(2, 10)}@example.test`,
    displayName: 'Owner',
    password: 'correct horse battery staple',
  });
  userId = user.id;
  const activated = await activate({
    projectId,
    ownerUserId: userId,
    actorUserId: userId,
    objective: 'Maximize additional usable cash over the next few weeks.',
  });
  expect(activated.ok).toBe(true);
  await createAuthority({
    projectId,
    ownerUserId: userId,
    createdByUserId: userId,
    name: 'Cash Mode commercial authority',
    allowedActions: [...COMMERCIAL_ACTIONS],
    prohibitions: [...ALWAYS_PROHIBITED_COMMERCIAL],
    maxCommittedCents: 100_000,
    maxPerActionCents: 40_000,
    maxConcurrent: 5,
    currency: 'USD',
  });
});

afterEach(() => {
  clearAdapters();
  if (repoRoot) fs.rmSync(repoRoot, { recursive: true, force: true });
  repoRoot = '';
});

async function makeRepository(): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fulfil-repo-'));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'subject', scripts: { test: 'node -e "0"' } }, null, 2),
  );
  fs.mkdirSync(path.join(root, 'server'), { recursive: true });
  fs.writeFileSync(path.join(root, 'server', 'one.txt'), 'one\n');
  await exec('git', ['init', '-b', 'main'], { cwd: root });
  await exec('git', ['config', 'user.email', 'fulfil@test'], { cwd: root });
  await exec('git', ['config', 'user.name', 'Fulfil Test'], { cwd: root });
  await exec('git', ['add', '-A'], { cwd: root });
  await exec('git', ['commit', '-m', 'initial', '--no-verify'], { cwd: root });
  return root;
}

/** An opportunity a buyer has agreed to, executing, with the agreement on the ledger. */
async function agreed(title = 'A paid intake repair', agreedCents = 75_000): Promise<string> {
  const captured = await capture({
    projectId,
    actorRef: userId,
    ownerUserId: userId,
    title,
    mechanism: 'EXPLICIT_PAID_REQUEST',
    currency: 'USD',
    requiredCapabilities: [],
  });
  if (!captured.ok) throw new Error(captured.reason);
  const id = captured.value.id;
  const filled = await fillCard({
    opportunityId: id,
    actorRef: userId,
    patch: {
      payer: 'The owner, who signs',
      reachableChannel: 'Replied on Tuesday',
      buyingSignal: 'Asked for a quote',
      signalObservedAt: '2026-09-15T09:00:00.000Z',
      offerScope: 'One fixed-scope intake repair',
      acceptanceCondition: 'Form submits and a test enquiry arrives',
      priceCents: agreedCents,
      deliveryMethod: 'One afternoon of configuration',
      fulfillmentOwner: 'Us',
      peakFundingCents: 0,
    },
  });
  if (!filled.ok) throw new Error(filled.reason);
  for (const field of [CAPTURE_KEY, ...qualificationKeys(null)]) {
    await recordCardFact({
      projectId,
      opportunityId: id,
      field,
      kind: 'PERSON',
      value: `The owner's own answer to ${field}.`,
      decidedBy: userId,
    });
  }
  expect((await markReady({ opportunityId: id, actorRef: userId })).ok).toBe(true);
  const began = await beginExecution({
    opportunityId: id,
    actorRef: userId,
    firstAction: {
      action: 'CONTACT_BUYER',
      performedBy: 'PERSON',
      detail: 'Sent the scope and price.',
      reference: 'msg-1',
      requestKey: actionKey(id, 'CONTACT_BUYER', 'first'),
    },
  });
  if (!began.ok) throw new Error(began.reason);
  await money(id, 'PIPELINE_AGREED', agreedCents, null, `agreed:${id}`);
  return id;
}

async function money(
  opportunityId: string,
  kind: 'PIPELINE_AGREED' | 'CUSTOMER_PAYMENT' | 'SETTLEMENT',
  amountCents: number,
  reference: string | null,
  key: string,
): Promise<void> {
  const written = await recordMoneyEvent({
    projectId,
    opportunityId,
    kind,
    amountCents,
    currency: 'USD',
    verifiedReference: reference,
    idempotencyKey: key,
    actorRef: userId,
  });
  if (!written.ok) throw new Error(written.reason);
}

async function reading(opportunityId: string) {
  return (await readFulfillment((await getOpportunity(opportunityId))!))!;
}

async function ledgerCount(opportunityId: string, kind: string): Promise<number> {
  const rows = await getDb().all<{ n: number }>(
    'SELECT COUNT(*) AS n FROM cash_money_entries WHERE opportunity_id = ? AND kind = ?',
    [opportunityId, kind],
  );
  return Number(rows[0]?.n ?? 0);
}

async function openNeedKeys(): Promise<string[]> {
  return (await listNeeds({ projectId, states: ['OPEN'] }))
    .map((one) => one.requestKey ?? '')
    .filter((key) => key.startsWith('fulfillment:'));
}

/** A refund provider whose every answer the test chooses. */
function refundProvider(send: (businessId: string) => Promise<SendOutcome>): { sends: () => number } {
  let sends = 0;
  registerAdapter({
    name: 'test.refund',
    effectClass: 'EXTERNAL_OPAQUE',
    namespace: REFUND_NAMESPACE.name,
    validate: (payload) => payload as Record<string, unknown>,
    fingerprintInputs: (payload) => payload,
    send: async (request) => {
      sends += 1;
      return send(request.businessId);
    },
  });
  return { sends: () => sends };
}

describe('the agreement asks for an obligation, and nothing is invented for it', () => {
  it('raises one need for how it is fulfilled, and settles it from the row once declared', async () => {
    const id = await agreed();
    const before = await reading(id);
    expect(before.stage).toBe('REQUIRED');
    expect(before.complete).toBe(false);

    await advanceFulfillment(projectId);
    await advanceFulfillment(projectId);
    expect(await openNeedKeys()).toEqual([`fulfillment:requirement:${id}`]);

    const declared = await declare({
      projectId,
      opportunityId: id,
      kind: 'PERSON',
      promise: 'Repair the intake form',
      performer: 'The owner',
      actorRef: userId,
    });
    expect(declared.ok).toBe(true);
    // The card's own acceptance condition is the default, so it is not typed twice.
    expect((await fulfillmentForOpportunity(projectId, id))!.acceptanceCondition).toBe(
      'Form submits and a test enquiry arrives',
    );
    const pass = await advanceFulfillment(projectId);
    expect(pass.needsSettled.length).toBe(1);
    expect(await openNeedKeys()).toEqual([]);
  });

  it('refuses a kind it does not know and a capability it does not have', async () => {
    const id = await agreed();
    const refused = await declare({
      projectId,
      opportunityId: id,
      kind: 'BRAIN_DOES_IT',
      promise: 'x',
      performer: 'y',
      actorRef: userId,
    });
    expect(refused.ok).toBe(false);
    const noRepo = await declare({
      projectId,
      opportunityId: id,
      kind: 'SOFTWARE',
      promise: 'Build it',
      performer: 'The Factory',
      actorRef: userId,
    });
    expect(noRepo.ok).toBe(false);
  });
});

describe('A: software fulfillment through the Factory', () => {
  it('submits one objective, reads completion from the campaign, and completes only on acceptance', async () => {
    repoRoot = await makeRepository();
    const id = await agreed('A booking widget for a salon');
    await declare({
      projectId,
      opportunityId: id,
      kind: 'SOFTWARE',
      promise: 'Ship the booking widget the salon agreed to',
      performer: 'The Software Factory',
      acceptanceCondition: 'A test booking reaches the salon calendar',
      repositoryRoot: repoRoot,
      mutationScope: ['server/**'],
      actorRef: userId,
    });

    const first = await advanceFulfillment(projectId);
    expect(first.workCreated).toHaveLength(1);
    // A second pass, and two at once, create nothing more.
    await Promise.all([advanceFulfillment(projectId), advanceFulfillment(projectId)]);
    const requests = await listChangeRequests(projectId);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.state).toBe('DRAFT');
    expect((await reading(id)).work.state).toBe('AWAITING_APPROVAL');
    expect((await reading(id)).personNext.join(' ')).toContain('Approve the Factory objective');

    // A worker saying it is done is not evidence.
    const claimed = await recordEvent({
      projectId,
      opportunityId: id,
      kind: 'WORK_COMPLETE',
      detail: 'done',
      evidenceRef: 'trust me',
      actorRef: userId,
    });
    expect(claimed.ok).toBe(false);

    const approved = await approveObjective({ changeRequestId: request.id, via: 'PERSON', userId });
    expect(approved.ok).toBe(true);
    const { campaign } = await ensureCampaign({
      changeRequestId: request.id,
      projectId,
      baseSha: request.baseSha,
      laneTarget: 1,
      laneTargetReason: 'initial',
    });
    expect((await reading(id)).work.state).toBe('IN_PROGRESS');
    // Delivery cannot precede the work.
    expect(
      (
        await recordEvent({
          projectId,
          opportunityId: id,
          kind: 'DELIVERED',
          detail: 'Sent the widget',
          evidenceRef: 'email-1',
          actorRef: userId,
        })
      ).ok,
    ).toBe(false);

    await patchCampaign(campaign.id, {
      state: 'COMPLETE',
      integrationSha: 'deadbeefcafe',
      finishedAt: factoryNow(),
      prUrl: 'https://github.com/example/salon/pull/7',
      prRef: '#7',
    });
    const built = await reading(id);
    expect(built.work.state).toBe('COMPLETE');
    expect(built.work.artifact).toBe('https://github.com/example/salon/pull/7');
    expect(built.stage).toBe('IN_PROGRESS');
    expect(built.complete).toBe(false);
    expect((await getCampaignByChangeRequest(request.id))!.state).toBe('COMPLETE');

    // Delivered is not accepted.
    await recordEvent({
      projectId,
      opportunityId: id,
      kind: 'DELIVERED',
      detail: 'Handed over the merged widget and its install steps',
      evidenceRef: 'https://github.com/example/salon/pull/7',
      actorRef: userId,
    });
    const delivered = await reading(id);
    expect(delivered.stage).toBe('DELIVERED');
    expect(delivered.complete).toBe(false);
    expect((await getOpportunity(id))!.state).toBe('DELIVERING');

    // Acceptance needs the buyer's own evidence.
    expect(
      (
        await recordEvent({
          projectId,
          opportunityId: id,
          kind: 'ACCEPTED',
          detail: 'Booked a test appointment',
          actorRef: userId,
        })
      ).ok,
    ).toBe(false);
    await recordEvent({
      projectId,
      opportunityId: id,
      kind: 'ACCEPTED',
      detail: 'The salon booked a test appointment and it reached their calendar',
      evidenceRef: 'email-from-salon-2026-10-02',
      actorRef: userId,
    });
    const done = await reading(id);
    expect(done.complete).toBe(true);
    expect(done.stage).toBe('COMPLETE');
    // Complete delivery is not available cash: nothing was paid or settled.
    expect(done.money.outstandingCents).toBe(75_000);
    expect((await cashPosition({ projectId, currency: 'USD' })).availableFundsCents).toBe(0);
  });

  it('raises a need with the Factory’s own refusal rather than inventing progress', async () => {
    const id = await agreed();
    await declare({
      projectId,
      opportunityId: id,
      kind: 'SOFTWARE',
      promise: 'Ship the widget',
      performer: 'The Software Factory',
      repositoryRoot: path.join(os.tmpdir(), 'no-such-repository-here'),
      actorRef: userId,
    });
    const pass = await advanceFulfillment(projectId);
    expect(pass.workCreated).toEqual([]);
    expect(await openNeedKeys()).toContain(`fulfillment:work:${id}`);
    expect((await reading(id)).work.state).toBe('NOT_CREATED');
  });
});

describe('B: research fulfillment through the pipeline', () => {
  it('captures one idea and reads completion from the filed mission', async () => {
    const id = await agreed('A competitor price survey');
    await declare({
      projectId,
      opportunityId: id,
      kind: 'RESEARCH',
      promise: 'Survey published prices for intake repairs in three cities',
      performer: 'Brain research',
      acceptanceCondition: 'A sourced table the buyer can check',
      actorRef: userId,
    });
    await advanceFulfillment(projectId);
    await advanceFulfillment(projectId);
    const fulfillment = (await fulfillmentForOpportunity(projectId, id))!;
    expect(fulfillment.workRef).toMatch(/^rcn_/);
    expect(await getCandidate(fulfillment.workRef!)).not.toBeNull();
    expect((await reading(id)).work.state).toBe('QUEUED');

    const { mission } = await launchMission({
      projectId,
      layerId,
      visibility: 'SHARED',
      candidateId: fulfillment.workRef!,
      objective: 'Survey prices',
      whyNow: 'A buyer is owed it',
      idempotencyKey: `fulfil-mission-${id}`,
    });
    expect((await reading(id)).work.state).toBe('IN_PROGRESS');
    await linkMission({ missionId: mission.id, documentId: 'doc_survey', auditId: 'aud_survey' });
    await transitionMission({ missionId: mission.id, from: 'PLANNED', to: 'RUNNING' });
    await transitionMission({ missionId: mission.id, from: 'RUNNING', to: 'DONE' });
    const filed = await reading(id);
    expect(filed.work.state).toBe('COMPLETE');
    expect(filed.work.artifact).toBe('doc_survey');

    await recordEvent({
      projectId,
      opportunityId: id,
      kind: 'DELIVERED',
      detail: 'Sent the survey',
      evidenceRef: 'doc_survey',
      actorRef: userId,
    });
    await recordEvent({
      projectId,
      opportunityId: id,
      kind: 'ACCEPTED',
      detail: 'Buyer checked the sources and approved',
      evidenceRef: 'reply-77',
      actorRef: userId,
    });
    expect((await reading(id)).complete).toBe(true);
  });
});

describe('C: a person performs it', () => {
  it('waits on the person, and only a recorded completion with evidence closes the work', async () => {
    const id = await agreed();
    await declare({
      projectId,
      opportunityId: id,
      kind: 'PERSON',
      promise: 'Configure the intake form',
      performer: 'Airyn',
      actorRef: userId,
    });
    await advanceFulfillment(projectId);
    const waiting = await reading(id);
    expect(waiting.work.state).toBe('WAITING_ON_PERSON');
    expect(waiting.personNext.join(' ')).toContain('Airyn');

    expect(
      (await recordEvent({ projectId, opportunityId: id, kind: 'WORK_COMPLETE', detail: 'Done', actorRef: userId }))
        .ok,
    ).toBe(false);
    await recordEvent({
      projectId,
      opportunityId: id,
      kind: 'WORK_COMPLETE',
      detail: 'Form configured',
      evidenceRef: 'screenshot-1',
      actorRef: userId,
    });
    expect((await reading(id)).work.state).toBe('COMPLETE');
  });
});

describe('D: a supplier performs it', () => {
  it('records the commitment, pays it once, and costs nothing twice', async () => {
    const id = await agreed('A printed run of flyers', 50_000);
    await declare({
      projectId,
      opportunityId: id,
      kind: 'SUPPLIER',
      promise: '500 printed flyers',
      performer: 'PrintCo',
      supplierName: 'PrintCo',
      actorRef: userId,
    });
    await advanceFulfillment(projectId);
    expect((await reading(id)).outstanding.join(' ')).toContain('supplier’s commitment');

    const commitment = {
      projectId,
      opportunityId: id,
      kind: 'SUPPLIER_COMMITMENT',
      amountCents: 12_000,
      detail: 'PrintCo quoted and accepted the order',
      reference: 'po-1',
      actorRef: userId,
    };
    expect((await recordCost(commitment)).ok).toBe(true);
    expect((await recordCost(commitment)).ok).toBe(true); // a retry
    expect(await ledgerCount(id, 'UNPAID_COMMITMENT')).toBe(1);
    const owed = await reading(id);
    expect(owed.money.unpaidCommitmentCents).toBe(12_000);
    expect(owed.money.costCents).toBe(0);

    const before = await cashPosition({ projectId, currency: 'USD' });
    const payment = {
      projectId,
      opportunityId: id,
      kind: 'SUPPLIER_PAYMENT',
      amountCents: 12_000,
      detail: 'Paid PrintCo',
      reference: 'bank-889',
      actorRef: userId,
    };
    expect((await recordCost(payment)).ok).toBe(true);
    expect((await recordCost(payment)).ok).toBe(true); // a retry after a lost response
    expect(await ledgerCount(id, 'COST')).toBe(1);
    expect(await ledgerCount(id, 'COMMITMENT_PAID')).toBe(1);
    const paid = await reading(id);
    expect(paid.money.unpaidCommitmentCents).toBe(0);
    expect(paid.money.costCents).toBe(12_000);
    const after = await cashPosition({ projectId, currency: 'USD' });
    // The cost left available funds once; deployable moved by the same amount
    // net of the commitment it closed — never twice.
    expect(after.availableFundsCents).toBe(before.availableFundsCents - 12_000);
    expect(after.deployableCents).toBe(before.deployableCents);

    // A payment needs proof it left; an estimate is not a cost.
    expect((await recordCost({ ...payment, reference: null, detail: 'estimated' })).ok).toBe(false);
  });

  it('records a supplier failing, keeps every row, and never calls it revenue', async () => {
    const id = await agreed('A printed run of posters', 50_000);
    await declare({
      projectId,
      opportunityId: id,
      kind: 'SUPPLIER',
      promise: '50 posters',
      performer: 'PrintCo',
      supplierName: 'PrintCo',
      actorRef: userId,
    });
    await advanceFulfillment(projectId);
    await recordEvent({
      projectId,
      opportunityId: id,
      kind: 'SUPPLIER_FAILED',
      detail: 'PrintCo cancelled the order',
      actorRef: userId,
    });
    const failed = await reading(id);
    expect(failed.stage).toBe('FAILED');
    expect(failed.complete).toBe(false);
    // Nothing more is recorded against a failed obligation except refunds.
    expect(
      (
        await recordEvent({
          projectId,
          opportunityId: id,
          kind: 'DELIVERED',
          detail: 'delivered anyway',
          evidenceRef: 'x',
          actorRef: userId,
        })
      ).ok,
    ).toBe(false);
    await advanceFulfillment(projectId);
    const observed = await listObservations({ projectId, opportunityId: id });
    expect(observed.some((one) => one.kind === 'SUPPLIER_RELIABILITY' && one.valueText.includes('failed'))).toBe(true);
  });
});

describe('E and F: partial payment and partial delivery', () => {
  it('keeps the remaining balance and the remaining obligation honest', async () => {
    const id = await agreed('A three-page site', 90_000);
    await declare({
      projectId,
      opportunityId: id,
      kind: 'PERSON',
      promise: 'Three pages built and live',
      performer: 'The owner',
      actorRef: userId,
    });
    await advanceFulfillment(projectId);
    await money(id, 'CUSTOMER_PAYMENT', 30_000, 'pay-1', 'pay-1');
    await money(id, 'CUSTOMER_PAYMENT', 30_000, 'pay-2', 'pay-2');
    await money(id, 'CUSTOMER_PAYMENT', 30_000, 'pay-2', 'pay-2'); // a retry
    const partPaid = await reading(id);
    expect(partPaid.money.paidCents).toBe(60_000);
    expect(partPaid.money.outstandingCents).toBe(30_000);
    // Paid is not settled, and settled is what is available.
    expect((await cashPosition({ projectId, currency: 'USD' })).availableFundsCents).toBe(0);

    await recordEvent({
      projectId,
      opportunityId: id,
      kind: 'PARTIALLY_DELIVERED',
      detail: 'Home page live',
      evidenceRef: 'https://example.test/',
      actorRef: userId,
    });
    const partDelivered = await reading(id);
    expect(partDelivered.delivery.state).toBe('PARTIAL');
    expect(partDelivered.delivery.remaining).toContain('Three pages built and live');
    // A partial delivery cannot be accepted as the whole.
    expect(
      (
        await recordEvent({
          projectId,
          opportunityId: id,
          kind: 'ACCEPTED',
          detail: 'looks good',
          evidenceRef: 'reply',
          actorRef: userId,
        })
      ).ok,
    ).toBe(false);
    expect(partDelivered.complete).toBe(false);
  });
});

describe('G: the buyer rejects the delivery', () => {
  it('is not complete, says so, and can be redelivered', async () => {
    const id = await agreed();
    await declare({
      projectId,
      opportunityId: id,
      kind: 'PERSON',
      promise: 'Repair the form',
      performer: 'The owner',
      actorRef: userId,
    });
    await advanceFulfillment(projectId);
    await recordEvent({ projectId, opportunityId: id, kind: 'WORK_COMPLETE', detail: 'Fixed', evidenceRef: 'c1', actorRef: userId });
    await recordEvent({ projectId, opportunityId: id, kind: 'DELIVERED', detail: 'Handed over', evidenceRef: 'd1', actorRef: userId });
    await recordEvent({
      projectId,
      opportunityId: id,
      kind: 'REJECTED',
      detail: 'The test enquiry never arrived',
      evidenceRef: 'reply-3',
      actorRef: userId,
    });
    const rejected = await reading(id);
    expect(rejected.stage).toBe('REJECTED');
    expect(rejected.complete).toBe(false);
    expect(rejected.outstanding.join(' ')).toContain('rejected');

    await recordEvent({ projectId, opportunityId: id, kind: 'DELIVERED', detail: 'Fixed the mail route', evidenceRef: 'd2', actorRef: userId });
    expect((await reading(id)).acceptance.state).toBe('AWAITING_ACCEPTANCE');
    await recordEvent({ projectId, opportunityId: id, kind: 'ACCEPTED', detail: 'It arrived', evidenceRef: 'reply-4', actorRef: userId });
    expect((await reading(id)).complete).toBe(true);
  });

  it('cannot accept against a condition nobody stated', async () => {
    const captured = await capture({
      projectId,
      actorRef: userId,
      ownerUserId: userId,
      title: 'No condition',
      mechanism: 'EXPLICIT_PAID_REQUEST',
      currency: 'USD',
      requiredCapabilities: [],
    });
    if (!captured.ok) throw new Error(captured.reason);
    const id = captured.value.id;
    await money(id, 'PIPELINE_AGREED', 10_000, null, `agreed:${id}`);
    await declare({ projectId, opportunityId: id, kind: 'PERSON', promise: 'Something', performer: 'Me', actorRef: userId });
    await advanceFulfillment(projectId);
    expect(await openNeedKeys()).toContain(`fulfillment:acceptance:${id}`);
    expect((await reading(id)).acceptance.state).toBe('NO_CONDITION');
  });
});

describe('H and I: refunds', () => {
  async function failedAndPaid(): Promise<string> {
    const id = await agreed('A job that went wrong', 40_000);
    await declare({ projectId, opportunityId: id, kind: 'PERSON', promise: 'The job', performer: 'Me', actorRef: userId });
    await advanceFulfillment(projectId);
    await money(id, 'CUSTOMER_PAYMENT', 40_000, 'pay-x', `pay-x-${id}`);
    await money(id, 'SETTLEMENT', 40_000, 'settle-x', `settle-x-${id}`);
    return id;
  }

  it('L: a failure after payment asks a person what is owed back, and a refund settles it', async () => {
    const id = await failedAndPaid();
    await recordEvent({ projectId, opportunityId: id, kind: 'FAILED', detail: 'Could not get access', actorRef: userId });
    await advanceFulfillment(projectId);
    expect(await openNeedKeys()).toContain(`fulfillment:refund-decision:${id}`);
    expect((await reading(id)).money.contributionCents).toBe(40_000);

    // Without a refund adapter, a refund is a person's to pay out.
    expect((await readCapability('ISSUE_A_REFUND')).state).toBe('MISSING');
    const authorized = await authorizeRefund({
      projectId,
      opportunityId: id,
      amountCents: 40_000,
      reason: 'The work could not be done',
      actorRef: userId,
    });
    expect(authorized.ok).toBe(true);
    expect((await reading(id)).refunds[0]!.state).toBe('PENDING');
    expect(await ledgerCount(id, 'REFUND')).toBe(0); // authorized is not refunded
    await advanceFulfillment(projectId);
    const keys = await openNeedKeys();
    expect(keys.some((key) => key.startsWith('fulfillment:refund:'))).toBe(true);
    expect(keys).not.toContain(`fulfillment:refund-decision:${id}`);

    // More than was paid is refused.
    expect(
      (await authorizeRefund({ projectId, opportunityId: id, amountCents: 1, reason: 'extra', actorRef: userId })).ok,
    ).toBe(false);

    const refundKey = (await reading(id)).refunds[0]!.refundKey;
    expect(
      (await answerRefund({ projectId, opportunityId: id, refundKey, answer: 'confirm', reference: '', actorRef: userId })).ok,
    ).toBe(false);
    const confirmed = await answerRefund({
      projectId,
      opportunityId: id,
      refundKey,
      answer: 'confirm',
      reference: 're_123',
      actorRef: userId,
    });
    expect(confirmed.ok).toBe(true);
    await answerRefund({ projectId, opportunityId: id, refundKey, answer: 'confirm', reference: 're_123', actorRef: userId });
    expect(await ledgerCount(id, 'REFUND')).toBe(1);
    const after = await reading(id);
    expect(after.money.contributionCents).toBe(0);
    expect(after.complete).toBe(false);
    await advanceFulfillment(projectId);
    expect(await openNeedKeys()).toEqual([]);
    const observations = await listObservations({ projectId, opportunityId: id });
    expect(observations.some((one) => one.kind === 'REFUND_REASON')).toBe(true);
  });

  it('H: with a provider, a confirmed refund writes one REFUND entry with its receipt', async () => {
    const provider = refundProvider(async (businessId) => ({ kind: 'CONFIRMED', receiptRef: `re_${businessId.length}` }));
    expect((await readCapability('ISSUE_A_REFUND')).state).toBe('PRESENT');
    const id = await failedAndPaid();
    const outcome = await authorizeRefund({
      projectId,
      opportunityId: id,
      amountCents: 15_000,
      reason: 'Partial goodwill refund',
      actorRef: userId,
    });
    expect(outcome.ok).toBe(true);
    await advanceFulfillment(projectId);
    await authorizeRefund({ projectId, opportunityId: id, amountCents: 15_000, reason: 'Partial goodwill refund', actorRef: userId });
    expect(provider.sends()).toBe(1);
    expect(await ledgerCount(id, 'REFUND')).toBe(1);
    const after = await reading(id);
    expect(after.refunds[0]!.state).toBe('CONFIRMED');
    expect(after.refunds[0]!.reference).toMatch(/^re_/);
    expect(after.money.contributionCents).toBe(25_000);
  });

  it('I: an unknown outcome stays unknown and is never sent again', async () => {
    const provider = refundProvider(async () => ({ kind: 'UNCERTAIN', reason: 'the provider timed out' }));
    const id = await failedAndPaid();
    await authorizeRefund({ projectId, opportunityId: id, amountCents: 40_000, reason: 'Refund in full', actorRef: userId });
    for (let i = 0; i < 3; i += 1) await advanceFulfillment(projectId);
    expect(provider.sends()).toBe(1);
    const unknown = await reading(id);
    expect(unknown.refunds[0]!.state).toBe('UNKNOWN');
    expect(await ledgerCount(id, 'REFUND')).toBe(0);
    expect(unknown.personNext.join(' ')).toContain('will not send it again');
    // An unknown refund counts against what may be refunded: it may have happened.
    expect(
      (await authorizeRefund({ projectId, opportunityId: id, amountCents: 100, reason: 'again', actorRef: userId })).ok,
    ).toBe(false);

    // A person with the provider's word settles it.
    const refundKey = unknown.refunds[0]!.refundKey;
    await answerRefund({ projectId, opportunityId: id, refundKey, answer: 'not-sent', reference: 'provider shows no refund', actorRef: userId });
    expect((await reading(id)).refunds[0]!.state).toBe('FAILED');
    expect(await ledgerCount(id, 'REFUND')).toBe(0);
    expect(provider.sends()).toBe(1);
  });
});

describe('J and K: restart and duplicate continuation', () => {
  it('a restart between creating the work and claiming it leaves one piece of work', async () => {
    repoRoot = await makeRepository();
    const id = await agreed('A form fix');
    const declared = await declare({
      projectId,
      opportunityId: id,
      kind: 'SOFTWARE',
      promise: 'Fix the intake form',
      performer: 'The Software Factory',
      repositoryRoot: repoRoot,
      mutationScope: ['server/**'],
      actorRef: userId,
    });
    if (!declared.ok) throw new Error(declared.reason);
    // The crash: the objective went in and the claim never happened.
    await submitObjective({
      projectId,
      objective: 'Fulfil an agreed customer obligation: Fix the intake form',
      expectedOutcome: 'The buyer can accept it against: Form submits and a test enquiry arrives',
      repositoryRoot: repoRoot,
      mutationScope: ['server/**'],
      submissionKey: `cash-fulfillment-${declared.value.id}`,
    });
    await restartDatabase();
    await advanceFulfillment(projectId);
    await advanceFulfillment(projectId);
    expect(await listChangeRequests(projectId)).toHaveLength(1);
    expect((await fulfillmentForOpportunity(projectId, id))!.workRef).toBe(
      (await listChangeRequests(projectId))[0]!.id,
    );
  });

  it('two passes at once open one obligation, one need set and no duplicate events', async () => {
    const id = await agreed();
    await Promise.all([advanceFulfillment(projectId), advanceFulfillment(projectId)]);
    expect(await openNeedKeys()).toEqual([`fulfillment:requirement:${id}`]);
    await declare({ projectId, opportunityId: id, kind: 'PERSON', promise: 'The job', performer: 'Me', actorRef: userId });
    const passes = await Promise.all([advanceFulfillment(projectId), advanceFulfillment(projectId)]);
    expect(passes.flatMap((one) => one.workCreated)).toHaveLength(1);
    const event = { projectId, opportunityId: id, kind: 'WORK_COMPLETE', detail: 'Done', evidenceRef: 'proof', actorRef: userId };
    await Promise.all([recordEvent(event), recordEvent(event)]);
    const rows = await getDb().all<{ n: number }>(
      "SELECT COUNT(*) AS n FROM cash_fulfillment_events WHERE opportunity_id = ? AND kind = 'WORK_COMPLETE'",
      [id],
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });
});

describe('the learning loop', () => {
  it('records a success once, keeps it when a refund follows, and shows the sample', async () => {
    const id = await agreed('A repeatable repair', 60_000);
    await declare({ projectId, opportunityId: id, kind: 'PERSON', promise: 'The repair', performer: 'Me', actorRef: userId });
    await advanceFulfillment(projectId);
    await money(id, 'CUSTOMER_PAYMENT', 60_000, 'p1', `p1-${id}`);
    await recordCost({ projectId, opportunityId: id, kind: 'INTERNAL_COST', amountCents: 5_000, detail: 'A test domain', reference: 'inv-1', actorRef: userId });
    await recordEvent({ projectId, opportunityId: id, kind: 'WORK_COMPLETE', detail: 'Repaired', evidenceRef: 'c', actorRef: userId });
    await recordEvent({ projectId, opportunityId: id, kind: 'DELIVERED', detail: 'Handed over', evidenceRef: 'd', actorRef: userId });
    await recordEvent({ projectId, opportunityId: id, kind: 'ACCEPTED', detail: 'Works', evidenceRef: 'a', actorRef: userId });
    await advanceFulfillment(projectId);
    await advanceFulfillment(projectId);
    const success = (await listObservations({ projectId, opportunityId: id })).filter((one) => one.outcome === 'SUCCESS');
    const contribution = success.find((one) => one.kind === 'REALIZED_CONTRIBUTION')!;
    expect(contribution.valueNumber).toBe(55_000);
    expect(success.filter((one) => one.kind === 'REALIZED_CONTRIBUTION')).toHaveLength(1);
    expect(success.find((one) => one.kind === 'AGREED_PRICE')!.valueNumber).toBe(60_000);
    expect(success.find((one) => one.kind === 'ACTUAL_COST')!.valueNumber).toBe(5_000);

    await authorizeRefund({ projectId, opportunityId: id, amountCents: 10_000, reason: 'Late by a day', actorRef: userId });
    const refundKey = (await reading(id)).refunds[0]!.refundKey;
    await answerRefund({ projectId, opportunityId: id, refundKey, answer: 'confirm', reference: 're_9', actorRef: userId });
    await advanceFulfillment(projectId);
    const all = await listObservations({ projectId, opportunityId: id });
    // The success observation is never rewritten; the refund is new beside it.
    expect(all.find((one) => one.id === contribution.id)!.valueNumber).toBe(55_000);
    expect(all.filter((one) => one.outcome === 'REFUND').map((one) => one.kind).sort()).toEqual([
      'REALIZED_CONTRIBUTION',
      'REFUND_REASON',
    ]);
    const lessons = await outcomeLessons(projectId);
    expect(lessons).toHaveLength(1);
    expect(lessons[0]!.obligations).toBe(1);
    expect(lessons[0]!.anecdote).toBe(true);
    expect(lessons[0]!.contributions).toEqual([45_000]);
  });
});

describe('closing a fulfillment need by hand', () => {
  it('cannot claim a refund decision that was never made', async () => {
    const id = await agreed();
    await declare({ projectId, opportunityId: id, kind: 'PERSON', promise: 'Job', performer: 'Me', actorRef: userId });
    await advanceFulfillment(projectId);
    await money(id, 'CUSTOMER_PAYMENT', 1_000, 'p', `p-${id}`);
    await recordEvent({ projectId, opportunityId: id, kind: 'ABANDONED', detail: 'Buyer went silent', actorRef: userId });
    await advanceFulfillment(projectId);
    const need = (await listNeeds({ projectId, states: ['OPEN'] })).find(
      (one) => one.requestKey === `fulfillment:refund-decision:${id}`,
    )!;
    const refused = await closeNeed({ needId: need.id, to: 'RESOLVED', resolution: 'Done.', actorUserId: userId });
    expect(refused.ok).toBe(false);
    // Withdrawing — keeping the payment, with the reason — is a person's to state.
    const kept = await closeNeed({
      needId: need.id,
      to: 'WITHDRAWN',
      resolution: 'The buyer agreed the deposit is kept for the time spent.',
      actorUserId: userId,
    });
    expect(kept.ok).toBe(true);
  });
});
